use std::net::SocketAddr;

use socket2::{Domain, Protocol, Socket, Type};
use tokio::{io, net::UdpSocket};

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
