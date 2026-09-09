use super::{Address, AddressInfo, StunHeader};

const IPV4_ATTR_LEN: u16 = 64;
const IPV6_ATTR_LEN: u16 = 160;
pub const ATTR_HEADER_LEN: u16 = 4;

#[derive(Clone, Copy)]
pub enum AttributeType {
    MappedAddress,
    Reserved,
    Username,
    MessageIntegrity,
    ErrorCode,
    UnknownAttributes,
    Realm,
    Nonce,
    XorMappedAddress,
}

impl From<AttributeType> for u16 {
    fn from(value: AttributeType) -> Self {
        match value {
            AttributeType::MappedAddress => 0x0001,
            AttributeType::Reserved => 0x0000,
            AttributeType::Username => 0x0006,
            AttributeType::MessageIntegrity => 0x0008,
            AttributeType::ErrorCode => 0x0009,
            AttributeType::UnknownAttributes => 0x000A,
            AttributeType::Realm => 0x0014,
            AttributeType::Nonce => 0x0015,
            AttributeType::XorMappedAddress => 0x0020,
        }
    }
}

impl TryFrom<u16> for AttributeType {
    type Error = ();

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            0x0000 => Ok(AttributeType::Reserved),
            0x0001 => Ok(AttributeType::MappedAddress),
            0x0002 => Ok(AttributeType::Reserved),
            0x0003 => Ok(AttributeType::Reserved),
            0x0004 => Ok(AttributeType::Reserved),
            0x0005 => Ok(AttributeType::Reserved),
            0x0006 => Ok(AttributeType::Username),
            0x0007 => Ok(AttributeType::Reserved),
            0x0008 => Ok(AttributeType::MessageIntegrity),
            0x0009 => Ok(AttributeType::ErrorCode),
            0x000A => Ok(AttributeType::UnknownAttributes),
            0x000B => Ok(AttributeType::Reserved),
            0x0014 => Ok(AttributeType::Realm),
            0x0015 => Ok(AttributeType::Nonce),
            0x0020 => Ok(AttributeType::XorMappedAddress),
            _ => Err(()),
        }
    }
}

pub struct AttributeHeader {
    pub attr_type: AttributeType,
    pub length: u16,
}

impl AttributeHeader {
    pub fn as_bytes(&self) -> [u8; 4] {
        let mut buf = [0u8; 4];
        let attr_type: u16 = self.attr_type.into();
        buf[0..].copy_from_slice(&attr_type.to_be_bytes());
        buf[2..].copy_from_slice(&self.length.to_be_bytes());

        return buf;
    }
}

pub struct EncodedXorAddress {
    bytes: [u8; IPV6_ATTR_LEN as usize],
    pub len: u16,
}

impl EncodedXorAddress {
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len as usize]
    }
}

pub struct XorAddressAttribute {
    pub x_port: u16,
    pub x_addr: Address,
}

impl From<XorAddressAttribute> for EncodedXorAddress {
    fn from(value: XorAddressAttribute) -> Self {
        let mut bytes = [0u8; IPV6_ATTR_LEN as usize];

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
    pub fn new(addr_info: AddressInfo, stun_header: &StunHeader) -> Self {
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
