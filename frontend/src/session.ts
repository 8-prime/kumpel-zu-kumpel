export type Role = 'sender' | 'receiver';
export type Session = { id: string; role: Role; key: string };

export function encodeKey(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function decodeKey(key: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('This link has an invalid encryption key. Ask for a new link.');
  const bytes = Uint8Array.from(atob(key.replaceAll('-', '+').replaceAll('_', '/') + '='), c => c.charCodeAt(0));
  if (bytes.length !== 32 || encodeKey(bytes) !== key) throw new Error('This link has an invalid encryption key. Ask for a new link.');
  return bytes;
}

export function readSession(url: URL): Session | null {
  const id = url.searchParams.get('session');
  const role = url.searchParams.get('role');
  const key = new URLSearchParams(url.hash.slice(1)).get('key');
  if (!id && !role && !key) return null;
  if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || (role !== 'sender' && role !== 'receiver') || !key) {
    throw new Error('This share link is incomplete. Ask the sender to copy the full link.');
  }
  decodeKey(key);
  return { id, role, key };
}

export function createSession(): Session {
  return { id: crypto.randomUUID(), role: 'sender', key: encodeKey(crypto.getRandomValues(new Uint8Array(32))) };
}

export function sessionUrl(base: string, session: Session, role = session.role): string {
  const url = new URL(base);
  url.search = new URLSearchParams({ session: session.id, role }).toString();
  url.hash = new URLSearchParams({ key: session.key }).toString();
  return url.href;
}

export function signalingUrl(base: string, session: Session): string {
  const url = new URL(base);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('Invalid signaling server URL.');
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = `/ws/${encodeURIComponent(session.id)}/${session.role}`;
  url.search = '';
  url.hash = '';
  return url.href;
}

export function opposite(role: Role): Role {
  return role === 'sender' ? 'receiver' : 'sender';
}
