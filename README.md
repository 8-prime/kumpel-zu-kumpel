# Kumpel zu Kumpel

Send encrypted files directly between browsers using WebRTC. The Rust signaling server also serves the built React frontend over HTTP.

## Docker

Build from the repository root:

```sh
docker build -t kumpel-zu-kumpel .
docker run --rm -p 3000:3000 kumpel-zu-kumpel
```

Open `http://localhost:3000`. The multi-stage build compiles the frontend and the `backend/server` Cargo project. The runtime image runs as a non-root user and contains the server binary and built frontend. HTTP and WebSocket signaling share port 3000.

For deployment, set a STUN URI reachable by both browsers:

```sh
docker run --rm -p 3000:3000 \
  -e STUN_SERVER=stun:stun.your-domain.example:3478 \
  kumpel-zu-kumpel
```

The STUN server runs separately; the existing `backend/stun/Dockerfile` builds it with `backend` as its build context. For access from other devices, put the app behind HTTPS and forward WebSocket upgrades on `/ws/` to the same server.

| Variable | Server default | Docker default |
| --- | --- | --- |
| `SIGNAL_ADDR` | `127.0.0.1:3000` | `0.0.0.0:3000` |
| `FRONTEND_DIR` | `../frontend/dist` (relative to the working directory) | `/app/frontend` |
| `STUN_SERVER` | `stun:127.0.0.1:3478` | Same; override for remote peers |

## Local development

See [frontend/README.md](frontend/README.md) for the Vite development server, protocol, and tests.

To serve a production frontend build directly through the Rust server:

```sh
cd frontend
npm ci
npm run build
cd ../backend
cargo run --locked -p server
```

Open `http://localhost:3000`. Set `FRONTEND_DIR` if running the server from a different working directory.
