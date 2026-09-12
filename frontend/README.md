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
- File plaintext frames contain a one-byte kind, four-byte big-endian sequence number, and payload. Kinds: hello `1`, offer `2`, chunk `3`, end `4`, receipt `5`, accept `6`, decline `7`, download progress `8`. Hello negotiates file protocol **2**; older peers receive an instruction to reload. Signaling and encryption packet formats are unchanged. Sequence checks reject replay or reordering; announced lengths and end markers are enforced.
- Each file is offered with its name and size. The sender waits until the receiver clicks **Accept download** and the browser opens the local download stream. Declining skips that file and continues the queue. No file content is read or sent before acceptance.
- Files stream sequentially in chunks smaller than 16 KiB. The sender can run at most 1 MiB ahead of acknowledged download progress, with additional data-channel backpressure. The receiver grants more credit only after its browser download stream accepts the chunks. Its encrypted receive queue is capped at 2 MiB / 256 frames, and its service-worker stream buffers at most one chunk. Browser/OS networking and disk buffers are managed by the browser.
- **No configured per-file or per-link byte quota.** Received bytes are decrypted and passed to the browser's normal download manager through a locally hosted service worker (`public/downloads/sw.js`). Files are never accumulated into a full-file Blob, placed in OPFS/IndexedDB/cache storage, or relayed to a download server. No `showSaveFilePicker()` or external download helper is used. The worker controls only `/downloads/`, uses one-use random URLs without keys or filenames, and fails unknown URLs locally.
- The browser chooses the destination using its normal download settings. The final peer receipt means the complete authenticated file was handed to the browser's download stream; the browser's Downloads UI is authoritative for the final filesystem save. Download frames remain until the session ends so Firefox can finish saving. Download cancellation or a write/connection failure stops the session and queued files. A stalled sender waits up to two minutes for progress; the receiver sends worker keep-alives every ten seconds. `waitUntil()` also extends the worker's lifetime while a download is active.
- Streaming requires HTTPS (or localhost) and enabled Service Worker/Streams APIs. Unsupported or blocked browser configurations fail explicitly; there is no full-file memory fallback. Desktop Firefox and Chromium use the same path. Safari/mobile require end-to-end verification before claiming support. Disk capacity and filesystem limits still apply. File sizes must be safe JavaScript integers and the authenticated frame sequence must not wrap.
- Keep both pages open. Resuming after interruption/reload is not implemented; partial downloads may need to be removed using the browser's Downloads UI. Large-file resume is separate from streaming support.
- STUN alone cannot connect every NAT/firewall combination. This version has no TURN fallback and shows a connection error if a direct route fails. Keep both pages open; a dropped connection requires a new link.

## Verification

```sh
npm test
npm run build
npx playwright install chromium firefox
npm run test:e2e
```

The browser suite starts the Vite and Rust signaling servers when needed. On Windows, set `PLAYWRIGHT_CHANNEL=msedge` to use installed Edge for the Chromium project. `npm run test:e2e -- --project=chromium` or `--project=firefox` selects one browser. Tests validate exact downloaded bytes, empty/Unicode files, acceptance, decline, cancellation, a 45-second pause, signaling closure, key isolation, wrong-key rejection, duplicate roles, and mobile layout. The large test generates 320 MiB by default with a small virtual source and verifies the downloaded SHA-256 using a Node file stream. Set `LARGE_TRANSFER_MIB=11264` for an actual 11 GiB transfer. Tests allocate that much download disk space; contexts clean up downloaded files afterward.

`npm run test:firefox-native` validates stock Firefox through WebDriver BiDi using an isolated profile with native download preferences. Set `FIREFOX_PATH` to its executable (defaults to the Windows installation path). It checks empty/Unicode files, a real encrypted P2P download (also configurable with `LARGE_TRANSFER_MIB`), and a 45-second pause. This avoids Firefox 150/151's automation-only `browser.setDownloadBehavior` restart workaround, which re-fetches one-use download URLs ([Mozilla bug 2017252](https://bugzilla.mozilla.org/show_bug.cgi?id=2017252), fixed in Firefox 152). Run it separately from the Playwright suite because both may start/stop the same local servers. It removes its temporary profile/downloads afterward. Native Firefox's Playwright BiDi channel does not implement download cancellation, so the standard Playwright suite uses its bundled Firefox instead.

Unit tests check that offers over 10 GiB do not read file data before acceptance, a stalled output bounds sender read-ahead, the transfer resumes without byte loss, disconnects reject pending acceptance, and flooding the encrypted receive queue fails safely. Same-machine browser tests can connect using host candidates and do not establish cross-network NAT compatibility. A passing 11 GiB run is not a claim that 50–100 GiB files or every browser/device have been tested.

From `backend`, `cargo test -p server` checks session pairing, relay direction, duplicate-role protection, and disconnect cleanup.
