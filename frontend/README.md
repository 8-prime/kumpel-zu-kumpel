# Kumpel zu Kumpel frontend

React + TypeScript + Vite, using the browser's native WebSocket, WebRTC, and Web Crypto APIs. The sender creates a link, the receiver opens it, and files travel directly between their devices over an ordered WebRTC data channel.

## Run locally

From `backend`, start the signaling server:

```sh
cargo run -p server
```

In a second terminal, start this repository's STUN server (also from `backend`):

```sh
cargo run -p stun
```

In a third terminal, from `frontend`:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`, create a link, and open the receiver link in another browser or tab. Vite proxies `/ws` to `127.0.0.1:3000`. The sender starts signaling immediately after creating the link; a receiver starts immediately on opening it.

For peers on different devices, serve the frontend through HTTPS, proxy `/ws` to the Rust server with WebSocket upgrade support, and set the Rust server's `STUN_SERVER` to a STUN URI reachable from **both clients** (for example `stun:stun.your-domain.example:3478`). The default `stun:127.0.0.1:3478` is only for local development. `SIGNAL_ADDR` sets the Rust listen address, defaulting to `127.0.0.1:3000`.

An optional build-time `VITE_SIGNALING_URL=https://signal.your-domain.example` selects a different signaling origin. The default uses the frontend's own origin. `npm run build` produces `frontend/dist`; the Rust server serves this directory at `http://127.0.0.1:3000` when started from `backend`. Set `FRONTEND_DIR` to override the static-file directory. The [root Dockerfile](../Dockerfile) builds and serves both projects in one image; see the [Docker instructions](../README.md#docker). `npm run preview` serves the build but does not proxy signaling, so use a configured signaling origin when previewing separately.

## Link and key handling

```text
https://files.example/?session=<uuid>&role=receiver#key=<base64url-256-bit-key>
```

The sender's own URL has `role=sender`. The key is created with `crypto.getRandomValues`, stays in the URL fragment and browser memory, and is never included in a signaling URL or message. There are no analytics, external fonts, or third-party scripts. A [URL fragment is not sent to the HTTP server](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment). Anyone with the complete link has the key, so the UI asks the sender to share it only with the intended peer.

WebRTC handles STUN internally: browser JavaScript cannot send a raw UDP STUN request or retrieve its raw response. Peers exchange SDP offers/answers containing gathered ICE candidates, as described in [WebRTC connectivity](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity). This implementation uses non-trickle ICE: wait for gathering (up to 12 seconds), then relay one encrypted description per peer. Candidates collected by that point can still provide a local connection if the STUN server is unavailable.

## Signaling contract

Endpoint: `/ws/{session_id}/{sender|receiver}`. Messages are JSON text frames. Both roles must be present before the server starts negotiation; duplicate roles are rejected.

1. Server → both clients:

   ```json
   { "type": "start_stun", "stun_server": "stun:127.0.0.1:3478" }
   ```

2. Sender creates a data channel, gathers an offer, and encrypts its SDP. Client → server:

   ```json
   { "type": "peer_information", "data": [1, 42, 73] }
   ```

   The array above only illustrates the shape. Real `data` is the complete encrypted byte packet (up to 64 KiB).

3. Server → opposite peer:

   ```json
   { "type": "receive_peer_information", "data": [1, 42, 73] }
   ```

   The receiver decrypts the offer, gathers its answer, and sends it through the same relay. The decrypted object is `{ connectionId, description: { type: "offer" | "answer", sdp } }`.

4. On data-channel open, both peers exchange an encrypted hello and verify possession of the link key. Each then sends `{ "type": "ready" }` and closes its WebSocket with code 1000 and reason `p2p-ready`. The server discards the session when both leave; file transfers continue without it.

Errors use `{ "type": "error", "message": "…" }`. A peer leaving before signaling finishes produces `{ "type": "peer_left" }` for the remaining peer.

## File transport

- Every signaling payload, hello, filename, metadata frame, data chunk, and receipt is encrypted/authenticated using AES-256-GCM with a fresh random 96-bit nonce. The key is imported as non-extractable. [AES-GCM parameter details](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams).
- Packet format: one version byte (`1`), 12 nonce bytes, then ciphertext with its 128-bit authentication tag. Authenticated additional data binds the session, message purpose, and sending role. File messages also bind a fresh connection ID exchanged inside the encrypted SDP.
- File plaintext frames contain a one-byte kind, four-byte big-endian sequence number, and payload. Kinds: hello `1`, metadata `2`, chunk `3`, end `4`, receipt `5`. Sequence checks reject replay or reordering. File length and end markers are checked before exposing a download.
- Files are sent sequentially in chunks smaller than 16 KiB, with data-channel backpressure. The sender displays success only after the receiver confirms successful decryption and reassembly.
- This first version keeps received files in browser memory and limits each link to **256 MiB total**. Downloads are explicit Save links. Object URLs are revoked when the session is reset or the page is closed. Streaming large files to disk and resumable transfers are not implemented.
- STUN alone cannot connect every NAT/firewall combination. This version has no TURN fallback and shows a connection error if a direct route fails. Keep both pages open; a dropped connection requires a new link.

## Verification

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The browser suite starts the Vite and Rust signaling servers when needed. On Windows, set `PLAYWRIGHT_CHANNEL=msedge` to use an installed Edge browser instead of installing Chromium. The tests use separate browser contexts, validate exact downloaded bytes (including empty and multi-chunk files), verify signaling closes before file transfer, check key isolation, wrong-key rejection, duplicate roles, and mobile layout. Same-machine tests can connect using host candidates and do not establish cross-network NAT compatibility.

From `backend`, `cargo test -p server` checks session pairing, relay direction, duplicate-role protection, and disconnect cleanup.
