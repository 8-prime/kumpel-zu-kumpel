pub mod attributes;

pub use zerocopy::{
    FromBytes, Immutable, IntoBytes, KnownLayout,
    network_endian::{U16, U32},
};

pub struct StunBuffer {
    bytes: [u8; 1500],
    len: usize,
}

impl StunBuffer {
    pub fn new() -> Self {
        Self {
            bytes: [0; 1500],
            len: 0,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<(), ()> {
        let end = self.len + bytes.len();

        if end > self.bytes.len() {
            return Err(());
        }

        self.bytes[self.len..end].copy_from_slice(bytes);
        self.len = end;

        Ok(())
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

pub enum Address {
    V4(u32),
    V6(u128),
}

pub struct AddressInfo {
    pub port: u16,
    pub addr: Address,
}

#[derive(FromBytes, IntoBytes, KnownLayout, Immutable)]
#[repr(C)]
pub struct StunHeader {
    pub message_type: U16,
    pub message_length: U16,
    pub magic_cookie: U32,
    pub transaction_id: [u8; 12],
}

#[derive(Debug, PartialEq)]
pub enum StunClass {
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

pub const BINDING: u16 = 0b1;
pub const MAGIC_COOKIE: u32 = 0x2112A442;

pub struct StunMessageType {
    pub class: StunClass,
    pub method: u16,
}

impl StunMessageType {
    pub fn is_binding(&self) -> bool {
        return self.method == BINDING;
    }
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

pub fn handle() -> eyre::Result {
    Ok(())
}
