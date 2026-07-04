#!/bin/sh
set -eu

REPO="baranwang/aio-proxy"
INSTALL_DIR="${AIO_PROXY_INSTALL_DIR:-$HOME/.local/bin}"

os="$(uname -s)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *)
    echo "aio-proxy: unsupported OS: $os (supported: macOS, Linux)" >&2
    exit 1
    ;;
esac

arch="$(uname -m)"
case "$arch" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *)
    echo "aio-proxy: unsupported architecture: $arch (supported: arm64, x64)" >&2
    exit 1
    ;;
esac

asset="aio-proxy-${os}-${arch}"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

mkdir -p "$INSTALL_DIR"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

echo "Downloading ${url} ..."
curl -fSL --progress-bar -o "$tmp" "$url"
chmod +x "$tmp"
mv "$tmp" "$INSTALL_DIR/aio-proxy"
trap - EXIT

echo "Installed aio-proxy to $INSTALL_DIR/aio-proxy"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "Note: $INSTALL_DIR is not in your PATH. Add it with:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
