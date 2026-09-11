# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend-builder

WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1.98-slim-bookworm AS backend-builder

WORKDIR /build/backend
COPY backend/ ./
RUN cargo build --locked --release -p server

FROM debian:bookworm-slim AS runtime

WORKDIR /app
ENV SIGNAL_ADDR=0.0.0.0:3000 \
    FRONTEND_DIR=/app/frontend

COPY --from=backend-builder /build/backend/target/release/server /usr/local/bin/server
COPY --from=frontend-builder /build/frontend/dist /app/frontend

USER 10001:10001
EXPOSE 3000/tcp

ENTRYPOINT ["/usr/local/bin/server"]
