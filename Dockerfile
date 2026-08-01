# syntax=docker/dockerfile:1

# Multi-arch image for aio-proxy.
#
# Stage 1 compiles a self-contained, musl-linked binary with Bun. Bun can
# cross-compile every target from a single (amd64) builder, so this stage is
# pinned to $BUILDPLATFORM and picks the musl target from $TARGETARCH — buildx
# produces both linux/amd64 and linux/arm64 without QEMU emulating the build.
# The dashboard assets are embedded into the binary by the compiled entry, so
# the runtime stage needs nothing but the binary itself.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.0 AS build
ARG TARGETARCH
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build
RUN case "$TARGETARCH" in \
      amd64) SUFFIX=linux-x64-musl ;; \
      arm64) SUFFIX=linux-arm64-musl ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    bun packages/cli/scripts/build-binary.ts "$SUFFIX" /out/aio-proxy

# Stage 2: minimal alpine runtime. The binary is musl-linked and self-contained.
FROM alpine:3.20
# wget (busybox) drives the HEALTHCHECK; ca-certificates for upstream TLS.
RUN apk add --no-cache ca-certificates \
    && adduser -D -u 10001 aioproxy \
    && mkdir -p /data && chown aioproxy:aioproxy /data
COPY --from=build /out/aio-proxy /usr/local/bin/aio-proxy

# Config, SQLite db and logs all live under AIO_PROXY_HOME. Mount a volume at
# /data to persist them across container restarts.
ENV AIO_PROXY_HOME=/data
VOLUME /data
USER aioproxy
EXPOSE 9317

# The config schema locks the server host to loopback, so a containerized
# server MUST bind 0.0.0.0 via the --host flag (it bypasses that validation).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:9317/health || exit 1
ENTRYPOINT ["aio-proxy"]
CMD ["run", "--host", "0.0.0.0"]
