# syntax=docker/dockerfile:1

# Multi-arch image for aio-proxy, built the turbo way.
#
# Stage 1 (prune) uses `turbo prune` to carve the @aio-proxy/cli subgraph and
# split it into a manifest-only `json/` tree and a source `full/` tree. Stage 2
# installs from `json/` FIRST so the dependency layer is cached on the lockfile
# alone — editing source no longer reinstalls. Bun cross-compiles a
# self-contained, musl-linked binary for $TARGETARCH from a single ($BUILDPLATFORM)
# builder, so buildx produces linux/amd64 and linux/arm64 without QEMU emulating
# the build. Dashboard assets are embedded into the binary by the compiled entry,
# so the runtime stage needs nothing but the binary itself.
# Pinned to Bun 1.3.14 (reproducible stable). The Bun 1.3.x bug where fetch with
# a proxy drops a ReadableStream request body is worked around in
# createProxyFetch (packages/core/src/provider/proxy-fetch.ts), not by the
# runtime. TODO(bun-1.4.0, issue #128): bump to oven/bun:1.4.0-alpine and remove
# that workaround once Bun 1.4.0 stable is released.
FROM --platform=$BUILDPLATFORM oven/bun:1.3.14-alpine AS prune
WORKDIR /src
COPY . .
# bunx runs turbo without a global install layer; pin the repo's major.
RUN bunx turbo@2 prune @aio-proxy/cli --docker

FROM --platform=$BUILDPLATFORM oven/bun:1.3.14-alpine AS build
ARG TARGETARCH
WORKDIR /src
# Manifests + lockfile only: this layer is cached until a package.json/lock changes.
COPY --from=prune /src/out/json/ ./
RUN bun install --frozen-lockfile
# Now the source; a source edit invalidates from here, not the install above.
COPY --from=prune /src/out/full/ ./
RUN bunx turbo run build
RUN case "$TARGETARCH" in \
      amd64) SUFFIX=linux-x64-musl ;; \
      arm64) SUFFIX=linux-arm64-musl ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    bun packages/cli/scripts/build-binary.ts "$SUFFIX" /out/aio-proxy

# Runtime stage: minimal alpine. The binary is musl-linked and self-contained.
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
