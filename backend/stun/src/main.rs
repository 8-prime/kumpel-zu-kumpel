use socket2::{Domain, Protocol, Socket, Type};
use std::{io, net::SocketAddr};
use tokio::{net::UdpSocket, task::JoinSet};

fn bind_worker(addr: SocketAddr) -> io::Result<UdpSocket> {
    let socket = Socket::new(Domain::for_address(addr), Type::DGRAM, Some(Protocol::UDP))?;

    // Windows has no SO_REUSEPORT; SO_REUSEADDR already allows multiple
    // sockets to bind the same addr:port there.
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    socket.set_reuse_port(true)?;
    socket.bind(&addr.into())?;
    socket.set_nonblocking(true)?;

    UdpSocket::from_std(socket.into())
}

async fn process(id: usize, socket: UdpSocket) -> io::Result<()> {
    let mut buf = vec![0u8; 32];
    let (len, addr) = socket.recv_from(&mut buf).await?;

    if len < 20 {
        return Ok(());
    }

    for b in &buf {
        print!("{:08b} ", b);
    }
    println!();

    return Ok(());
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let addr = SocketAddr::from(([0, 0, 0, 0], 3478));
    let workers = std::thread::available_parallelism()?.get();

    let mut tasks = JoinSet::new();
    for id in 0..workers {
        tasks.spawn(process(id, bind_worker(addr)?));
    }

    while let Some(result) = tasks.join_next().await {
        result??;
    }
    Ok(())
}
