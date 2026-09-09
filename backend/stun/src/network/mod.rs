use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

use socket2::{Domain, Protocol, Socket, Type};
use tokio::{io, net::UdpSocket};

use crate::stun::{Address, handle};

pub fn bind_worker(addr: SocketAddr) -> io::Result<Arc<UdpSocket>> {
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

    Ok(Arc::new(UdpSocket::from_std(socket.into())?))
}

pub async fn process(_: usize, socket: Arc<UdpSocket>) -> eyre::Result<()> {
    let mut buf = [0u8; 32];
    loop {
        let (len, addr) = socket.recv_from(&mut buf).await?;
        let address = stun_address(addr.ip());

        let stun_buffer = handle(&buf[..len], address, addr.port())?;
        socket.send_to(stun_buffer.as_bytes(), addr).await?;
    }
}

fn stun_address(ip: IpAddr) -> Address {
    match ip {
        IpAddr::V4(ipv4_addr) => Address::V4(u32::from_be_bytes(ipv4_addr.octets())),
        IpAddr::V6(ipv6_addr) => match ipv6_addr.octets() {
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, a, b, c, d] => {
                Address::V4(u32::from_be_bytes([a, b, c, d]))
            }
            octets => Address::V6(u128::from_be_bytes(octets)),
        },
    }
}
