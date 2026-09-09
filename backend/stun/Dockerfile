# syntax=docker/dockerfile:1

FROM rust:1.85-slim-bookworm AS builder

WORKDIR /workspace
COPY . .

RUN cargo build --locked --release -p stun

FROM debian:bookworm-slim AS runtime

COPY --from=builder /workspace/target/release/stun /usr/local/bin/stun

USER 10001:10001
EXPOSE 3478/udp

ENTRYPOINT ["/usr/local/bin/stun"]
