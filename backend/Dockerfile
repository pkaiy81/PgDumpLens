# Build stage
FROM rust:1.92-alpine AS builder

RUN apk add --no-cache musl-dev openssl-dev openssl-libs-static pkgconf

WORKDIR /app

# Copy manifests
COPY Cargo.toml Cargo.lock ./
COPY core/Cargo.toml ./core/
COPY api/Cargo.toml ./api/
COPY worker/Cargo.toml ./worker/

# Create dummy source files for dependency caching
RUN mkdir -p core/src api/src worker/src && \
    echo "pub fn dummy() {}" > core/src/lib.rs && \
    echo "fn main() {}" > api/src/main.rs && \
    echo "fn main() {}" > worker/src/main.rs

# Build dependencies only
RUN cargo build --release --bin api-server && \
    rm -rf core/src api/src worker/src

# Copy actual source code
COPY core ./core
COPY api ./api
COPY worker ./worker

# Build the actual binaries
RUN touch core/src/lib.rs api/src/main.rs worker/src/main.rs && \
    cargo build --release --bin api-server --bin worker

# Runtime stage
FROM alpine:3.19 AS runtime

RUN apk add --no-cache ca-certificates libgcc postgresql-client

WORKDIR /app

# Copy binaries
COPY --from=builder /app/target/release/api-server /app/
COPY --from=builder /app/target/release/worker /app/

# Copy migrations
COPY migrations ./migrations

# Create non-root user
RUN addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 8080

CMD ["./api-server"]
