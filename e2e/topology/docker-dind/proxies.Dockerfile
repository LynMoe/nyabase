FROM rust:1.95-bookworm AS builder

WORKDIR /src
COPY tools/ssh-proxy /src/ssh-proxy
COPY tools/http-proxy /src/http-proxy
RUN cargo build --release --locked --manifest-path /src/ssh-proxy/Cargo.toml \
    && cargo build --release --locked --manifest-path /src/http-proxy/Cargo.toml

FROM debian:bookworm-slim AS ssh-proxy
COPY --from=builder /src/ssh-proxy/target/release/nyabase-ssh-proxy /usr/local/bin/nyabase-ssh-proxy
USER 65532:65532
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/nyabase-ssh-proxy"]

FROM debian:bookworm-slim AS http-proxy
COPY --from=builder /src/http-proxy/target/release/nyabase-http-proxy /usr/local/bin/nyabase-http-proxy
USER 65532:65532
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/nyabase-http-proxy"]
