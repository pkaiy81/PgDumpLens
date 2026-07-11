# Base and runtime images can be overridden to pull from an internal Docker proxy.
ARG BASE_IMAGE=rust:1.92-alpine
ARG RUNTIME_IMAGE=alpine:3.19

# Build stage
FROM ${BASE_IMAGE} AS builder

RUN apk add --no-cache musl-dev openssl-dev openssl-libs-static pkgconf

WORKDIR /app

# Optional internal cargo registry (e.g. JFrog Artifactory) via source
# replacement. When unset, crates.io is used and behavior is unchanged.
# Example: sparse+https://mycompany.jfrog.io/artifactory/api/cargo/crates-remote/index/
# This MUST run before the first (dependency-caching) cargo build below.
ARG CARGO_REGISTRY=
RUN if [ -n "$CARGO_REGISTRY" ]; then \
      mkdir -p "$CARGO_HOME" && \
      printf '[source.crates-io]\nreplace-with = "internal"\n\n[source.internal]\nregistry = "%s"\n' "$CARGO_REGISTRY" \
        >> "$CARGO_HOME/config.toml"; \
    fi

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
FROM ${RUNTIME_IMAGE} AS runtime

RUN apk add --no-cache ca-certificates libgcc postgresql-client

WORKDIR /app

# Copy binaries
COPY --from=builder /app/target/release/api-server /app/
COPY --from=builder /app/target/release/worker /app/

# Copy migrations
COPY migrations ./migrations

# Create upload directory
RUN mkdir -p /data/uploads

EXPOSE 8080

CMD ["./api-server"]
