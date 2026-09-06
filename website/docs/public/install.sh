#!/bin/sh
set -eu

# Prebuilt binaries ship as per-platform npm packages (@aio-proxy/cli-<os>-<arch>),
# not as GitHub Release assets — the release pipeline never uploads those. This is
# the same artifact `aio-proxy upgrade` downloads (packages/cli/src/upgrade/binary.ts)
# and the same tarball the Homebrew tap pins, so all three channels install one
# published binary.
REGISTRY="${AIO_PROXY_REGISTRY:-https://registry.npmjs.org}"
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

registry="${REGISTRY%/}"
version="${AIO_PROXY_VERSION:-}"
if [ -z "$version" ]; then
  echo "Resolving the latest aio-proxy version ..."
  version="$(curl -fsSL "$registry/-/package/aio-proxy/dist-tags" |
    sed -n 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ -z "$version" ]; then
    echo "aio-proxy: could not resolve the latest version from $registry" >&2
    exit 1
  fi
fi

pkg="cli-${os}-${arch}"
url="${registry}/@aio-proxy/${pkg}/-/${pkg}-${version}.tgz"
aiop="$INSTALL_DIR/aiop"

mkdir -p "$INSTALL_DIR"
if [ -L "$aiop" ]; then
  current="$(readlink "$aiop")"
  case "$current" in
    aio-proxy | "$INSTALL_DIR/aio-proxy") ;;
    *)
      echo "aio-proxy: refusing to replace existing $aiop -> $current" >&2
      exit 1
      ;;
  esac
elif [ -e "$aiop" ]; then
  echo "aio-proxy: refusing to replace existing $aiop" >&2
  exit 1
fi

tgz="$(mktemp "$INSTALL_DIR/.aio-proxy.tgz.XXXXXX")"
tmp="$(mktemp "$INSTALL_DIR/.aio-proxy.tmp.XXXXXX")"
trap 'rm -f "$tgz" "$tmp"' INT TERM EXIT

echo "Downloading aio-proxy ${version} (${os}-${arch}) ..."
curl -fSL --progress-bar -o "$tgz" "$url"

# `npm pack` lays the binary out at package/bin/aio-proxy (see
# packages/cli/scripts/build-binary.ts, which writes npm/cli-*/bin/aio-proxy).
tar -xzOf "$tgz" package/bin/aio-proxy > "$tmp"
if [ ! -s "$tmp" ]; then
  echo "aio-proxy: downloaded package is missing bin/aio-proxy" >&2
  exit 1
fi

chmod +x "$tmp"
mv "$tmp" "$INSTALL_DIR/aio-proxy"
ln -sfn aio-proxy "$aiop"
rm -f "$tgz"
trap - INT TERM EXIT

echo "Installed aio-proxy ${version} to $INSTALL_DIR/aio-proxy"
echo "Short command: $INSTALL_DIR/aiop"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "Note: $INSTALL_DIR is not in your PATH. Add it with:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
