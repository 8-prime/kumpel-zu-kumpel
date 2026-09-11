import { decodeKey } from './session';

const encoder = new TextEncoder();
const VERSION = 1;

export async function importSessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', decodeKey(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// A fresh 96-bit nonce for every encryption, including metadata and signaling.
// Context authenticates the session, direction, and purpose of each message.
export async function encrypt(key: CryptoKey, data: Uint8Array<ArrayBuffer>, context: string): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context), tagLength: 128 }, key, data,
  );
  const packet = new Uint8Array(1 + iv.length + ciphertext.byteLength);
  packet[0] = VERSION;
  packet.set(iv, 1);
  packet.set(new Uint8Array(ciphertext), 13);
  return packet.buffer;
}

export async function decrypt(key: CryptoKey, packet: ArrayBuffer, context: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(packet);
  if (bytes.length < 29 || bytes[0] !== VERSION) throw new Error('Unsupported encrypted message.');
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(1, 13), additionalData: encoder.encode(context), tagLength: 128 },
      key, bytes.slice(13),
    ));
  } catch {
    throw new Error('Could not authenticate the peer’s data. Check that both peers have the same share link.');
  }
}
