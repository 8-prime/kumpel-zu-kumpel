use socket2::{Domain, Protocol, Socket, Type};
use std::{
    io::{self},
    net::SocketAddr,
};
use tokio::{net::UdpSocket, task::JoinSet};
use zerocopy::{FromBytes, IntoBytes};

use crate::stun::{
    Address, AddressInfo, BINDING, MAGIC_COOKIE, StunBuffer, StunClass, StunHeader,
    StunMessageType,
    attributes::{
        ATTR_HEADER_LEN, AttributeHeader, AttributeType, EncodedXorAddress, XorAddressAttribute,
    },
};

mod network;
mod stun;

fn bind_worker(addr: SocketAddr) -> io::Result<UdpSocket> {
    let socket = Socket::new(Domain::for_address(addr), Type::DGRAM, Some(Protocol::UDP))?;

    if addr.is_ipv6() {
        socket.set_only_v6(false)?;
    }

    // Windows has no SO_REUSEPORT; SO_REUSEADDR already allows multiple
    // sockets to bind the same addr:port there.
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    socket.set_reuse_port(true)?;
    socket.bind(&addr.into())?;
    socket.set_nonblocking(true)?;

    UdpSocket::from_std(socket.into())
}

async fn process(_: usize, socket: UdpSocket) -> eyre::Result<()> {
    let mut buf = vec![0u8; 32];
    let (len, addr) = socket.recv_from(&mut buf).await?;
    if len < 20 {
        return Ok(());
    }
    let (header, _): (&StunHeader, &[u8]) =
        StunHeader::ref_from_prefix(buf.as_ref()).map_err(|err| eyre::eyre!("{err}"))?;

    let message_type: StunMessageType = u16::from(header.message_type)
        .try_into()
        .map_err(|_| eyre::eyre!("Womp womp"))?;

    if u32::from(header.magic_cookie) != MAGIC_COOKIE {
        eyre::bail!("Invalid cookie");
    }

    if message_type.class != StunClass::Request {
        eyre::bail!("Unspported stun class");
    }

    if !message_type.is_binding() {
        eyre::bail!("I cannot handle non binding requests as of right now");
    }

    let address = match addr.ip() {
        std::net::IpAddr::V4(ipv4_addr) => Address::V4(u32::from_be_bytes(ipv4_addr.octets())),
        std::net::IpAddr::V6(ipv6_addr) => Address::V6(u128::from_be_bytes(ipv6_addr.octets())),
    };

    let address_info = AddressInfo {
        port: addr.port(),
        addr: address,
    };

    let x_or_attr = XorAddressAttribute::new(address_info, header);
    let encoded: EncodedXorAddress = x_or_attr.into();

    let attr_info = AttributeHeader {
        attr_type: AttributeType::XorMappedAddress,
        length: encoded.len,
    };

    let response_message_type = StunMessageType {
        class: StunClass::Success,
        method: BINDING,
    };
    let response_message: u16 = response_message_type.into();
    let response_header = StunHeader {
        magic_cookie: header.magic_cookie,
        message_length: encoded.len.into(),
        message_type: (response_message + ATTR_HEADER_LEN).into(),
        transaction_id: header.transaction_id,
    };

    let mut stun_buffer = StunBuffer::new();
    stun_buffer
        .push(response_header.as_bytes())
        .map_err(|_| eyre::eyre!("Failed to build response buffer"))?;

    stun_buffer
        .push(attr_info.as_bytes().as_ref())
        .map_err(|_| eyre::eyre!("Failed to build response buffer"))?;

    stun_buffer
        .push(encoded.as_bytes())
        .map_err(|_| eyre::eyre!("Failed to build response buffer"))?;

    socket.send_to(stun_buffer.as_bytes(), addr).await?;
    return Ok(());
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let addr = SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, 3478));
    let workers = std::thread::available_parallelism()?.get();

    let mut tasks = JoinSet::new();
    for id in 0..workers {
        tasks.spawn(process(id, bind_worker(addr)?));
    }

    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => eprintln!("STUN worker error: {err:?}"),
            Err(err) => eprintln!("STUN worker task failed: {err}"),
        }
    }
    Ok(())
}
