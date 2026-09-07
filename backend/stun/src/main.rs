use socket2::{Domain, Protocol, Socket, Type};
use std::{io, net::SocketAddr};
use tokio::{net::UdpSocket, task::JoinSet};

enum StunClass {
    Request,
    Indication,
    Success,
    ErrorResponse,
}

impl TryFrom<u16> for StunClass {
    type Error = ();

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            0b00 => Ok(StunClass::Request),
            0b01 => Ok(StunClass::Indication),
            0b10 => Ok(StunClass::Success),
            0b11 => Ok(StunClass::ErrorResponse),
            _ => Err(()),
        }
    }
}

const BINDING: u8 = 0b1;

enum MessageType {}

struct StunMessageType {
    class: StunClass,
    is_binding: bool,
}

impl TryFrom<u16> for StunMessageType {
    type Error = ();

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        if ((value & 0b1100_0000_0000_0000) >> 14) != 0b00 {
            return Err(());
        }

        let message_low = value & 0b0000_0000_0000_1111;
        let message_mid = (value & 0b0000_0000_1110_0000) >> 1;
        let message_high = (value & 0b0011_1110_1110_0000) >> 2;
        let message = message_high | message_mid | message_low;

        let class_low = (value & 0b0000_0000_0001_0000) >> 4;
        let class_high = (value & 0b0000_0001_0000_0000) >> 7;
        let class = class_high | class_low;
        let stun_class = class.try_into()?;

        return Ok(StunMessageType {
            class: StunClass::Indication,
            is_binding: true,
        });
    }
}

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
