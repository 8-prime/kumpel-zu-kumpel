use std::net::SocketAddr;

use socket2::{Domain, Protocol, Socket, Type};
use tokio::{io, net::UdpSocket};

use crate::stun::{Address, handle};

pub fn bind_worker(addr: SocketAddr) -> io::Result<UdpSocket> {
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

pub async fn process(_: usize, socket: UdpSocket) -> eyre::Result<()> {
    let mut buf = vec![0u8; 32];
    let (len, addr) = socket.recv_from(&mut buf).await?;
    print!("Received incoming stun request");
    let address = match addr.ip() {
        std::net::IpAddr::V4(ipv4_addr) => Address::V4(u32::from_be_bytes(ipv4_addr.octets())),
        std::net::IpAddr::V6(ipv6_addr) => Address::V6(u128::from_be_bytes(ipv6_addr.octets())),
    };

    let stun_buffer = handle(&buf[..len], address, addr.port())?;
    println!("Sending buffer to client");
    socket.send_to(stun_buffer.as_bytes(), addr).await?;
    println!("Sent buffer to client");
    return Ok(());
}
