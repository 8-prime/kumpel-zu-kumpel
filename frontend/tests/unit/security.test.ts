import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, importSessionKey } from '../../src/crypto';
import { createSession, decodeKey, readSession, sessionUrl, signalingUrl } from '../../src/session';

describe('share links', () => {
  it('keeps the 256-bit key exclusively in the fragment, including on the receiver link', () => {
    const session = createSession();
    const url = new URL(sessionUrl('https://files.example/', session, 'receiver'));
    expect(decodeKey(session.key)).toHaveLength(32);
    expect(url.searchParams.get('role')).toBe('receiver');
    expect(url.searchParams.has('key')).toBe(false);
    expect(url.search.includes(session.key)).toBe(false);
    expect(readSession(url)).toEqual({ ...session, role: 'receiver' });
    expect(signalingUrl(url.href, session)).toBe(`wss://files.example/ws/${session.id}/sender`);
  });

  it('rejects partial links and malformed keys instead of creating a different session', () => {
    expect(readSession(new URL('https://files.example/'))).toBeNull();
    expect(() => readSession(new URL('https://files.example/?session=x&role=receiver'))).toThrow('incomplete');
    expect(() => readSession(new URL('https://files.example/?session=x&role=receiver#key=bad'))).toThrow('invalid encryption key');
    expect(() => decodeKey('A'.repeat(42) + 'B')).toThrow();
  });
});

describe('authenticated encryption', () => {
  it('decrypts binary data and uses a fresh nonce for each message', async () => {
    const key = await importSessionKey(createSession().key);
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    const first = await encrypt(key, bytes, 'session:sender');
    const second = await encrypt(key, bytes, 'session:sender');
    expect(new Uint8Array(first)).not.toEqual(new Uint8Array(second));
    expect(await decrypt(key, first, 'session:sender')).toEqual(bytes);
  });

  it('rejects a wrong key, changed ciphertext, or changed session/direction', async () => {
    const key = await importSessionKey(createSession().key);
    const wrongKey = await importSessionKey(createSession().key);
    const packet = await encrypt(key, new TextEncoder().encode('private data'), 'session:sender');
    await expect(decrypt(wrongKey, packet, 'session:sender')).rejects.toThrow('authenticate');
    await expect(decrypt(key, packet, 'session:receiver')).rejects.toThrow('authenticate');
    const changed = packet.slice(0);
    new Uint8Array(changed)[changed.byteLength - 1] ^= 1;
    await expect(decrypt(key, changed, 'session:sender')).rejects.toThrow('authenticate');
  });
});
