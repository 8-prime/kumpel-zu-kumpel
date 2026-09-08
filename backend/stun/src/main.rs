use eyre::Ok;
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    io::{self},
    net::SocketAddr,
};
use tokio::{net::UdpSocket, task::JoinSet};
use zerocopy::{
    FromBytes, Immutable, KnownLayout,
    network_endian::{U16, U32},
};

pub enum Address {
    V4(u32),
    V6(u128),
}
const IPV4_ATTR_LEN: usize = 64;
const IPV6_ATTR_LEN: usize = 160;

struct EncodedXorAddress {
    bytes: [u8; IPV6_ATTR_LEN],
    len: usize,
}

impl EncodedXorAddress {
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

pub struct XorAddressAttribute {
    pub x_port: u16,
    pub x_addr: Address,
}

impl From<XorAddressAttribute> for EncodedXorAddress {
    fn from(value: XorAddressAttribute) -> Self {
        let mut bytes = [0u8; IPV6_ATTR_LEN];

        let len = match value.x_addr {
            Address::V4(_) => IPV4_ATTR_LEN,
            Address::V6(_) => IPV6_ATTR_LEN,
        };

        let add_family: u8 = match value.x_addr {
            Address::V4(_) => 0x01,
            Address::V6(_) => 0x02,
        };

        bytes[1] = add_family;
        bytes[2..].copy_from_slice(&value.x_port.to_be_bytes());

        match value.x_addr {
            Address::V4(v4) => bytes[3..].copy_from_slice(&v4.to_be_bytes()),
            Address::V6(v6) => bytes[3..].copy_from_slice(&v6.to_be_bytes()),
        };

        return EncodedXorAddress { bytes, len };
    }
}

impl XorAddressAttribute {
    pub fn new(addr_info: AddressInfo, stun_header: StunHeader) -> Self {
        match addr_info.addr {
            Address::V4(v4) => {
                return XorAddressAttribute {
                    x_port: addr_info.port ^ ((stun_header.magic_cookie.get() >> 16) as u16),
                    x_addr: Address::V4(v4 ^ stun_header.magic_cookie.get()),
                };
            }
            Address::V6(v6) => {
                let mut x_or_bytes: [u8; 16] = [0; 16];
                x_or_bytes[..4].copy_from_slice(&stun_header.magic_cookie.to_bytes());
                x_or_bytes[4..].copy_from_slice(&stun_header.transaction_id);
                let x_or_mask = u128::from_be_bytes(x_or_bytes);

                return XorAddressAttribute {
                    x_port: addr_info.port ^ ((stun_header.magic_cookie.get() >> 16) as u16),
                    x_addr: Address::V6(v6 ^ x_or_mask),
                };
            }
        }
    }
}

pub struct AddressInfo {
    pub port: u16,
    pub addr: Address,
}

#[derive(FromBytes, KnownLayout, Immutable)]
#[repr(C)]
pub struct StunHeader {
    pub message_type: U16,
    pub message_length: U16,
    pub magic_cookie: U32,
    pub transaction_id: [u8; 12],
}

#[derive(Debug, PartialEq)]
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

impl From<StunClass> for u16 {
    fn from(value: StunClass) -> Self {
        match value {
            StunClass::Request => 0b00,
            StunClass::Indication => 0b01,
            StunClass::Success => 0b10,
            StunClass::ErrorResponse => 0b11,
        }
    }
}

const BINDING: u16 = 0b1;
const MAGIC_COOKIE: u32 = 0x2112A442;

struct StunMessageType {
    class: StunClass,
    is_binding: bool,
    method: u16,
}

impl TryFrom<u16> for StunMessageType {
    type Error = ();

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        if ((value & 0b1100_0000_0000_0000) >> 14) != 0b00 {
            return Err(());
        }

        let method_low = value & 0b0000_0000_0000_1111;
        let method_mid = (value & 0b0000_0000_1110_0000) >> 1;
        let method_high = (value & 0b0011_1110_0000_0000) >> 2;
        let method = method_high | method_mid | method_low;

        let class_low = (value & 0b0000_0000_0001_0000) >> 4;
        let class_high = (value & 0b0000_0001_0000_0000) >> 7;
        let class = class_high | class_low;
        let stun_class = class.try_into()?;

        return Ok(StunMessageType {
            class: stun_class,
            is_binding: method == BINDING,
            method,
        });
    }
}

impl From<StunMessageType> for u16 {
    fn from(value: StunMessageType) -> Self {
        let mut message_bits = 0;
        let method_low = value.method & 0b0000_0000_0000_1111;
        let method_mid = (value.method & 0b0000_0000_0111_0000) << 1;
        let method_high = (value.method & 0b0000_1111_1000_0000) << 2;
        message_bits |= method_high | method_mid | method_low;

        let class_bytes: u16 = value.class.into();

        let class_high = (class_bytes & 0b0000_0000_0000_0010) << 7;
        let class_low = (class_bytes & 0b0000_0000_0000_0001) << 4;

        message_bits |= class_high | class_low;
        return message_bits;
    }
}

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

async fn process(id: usize, socket: UdpSocket) -> eyre::Result<()> {
    let mut buf = vec![0u8; 32];
    let (len, addr) = socket.recv_from(&mut buf).await?;
    println!("Received some shit");
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
        println!("I cannot handle non request class stun request");
        eyre::bail!("Unspported stun class");
    }

    println!(
        "Received request with class {:?} and is binding {}",
        message_type.class, message_type.is_binding
    );

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
