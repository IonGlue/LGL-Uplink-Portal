FROM rust:1.82-bookworm AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/lgl-uplink-portal /usr/local/bin/
COPY config/uplink.example.toml /etc/lgl-uplink-portal/uplink.toml
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1
CMD ["lgl-uplink-portal", "/etc/lgl-uplink-portal/uplink.toml"]
