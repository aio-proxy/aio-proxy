#!/bin/sh
# Installs NSIS 3.13 from the official SourceForge file after checking its SHA-256.
# The hash is the file at https://nsis.sourceforge.io/Download for NSIS 3.13
# (nsis-3.13-setup.exe), also recorded in the Chocolatey nsis.install 3.13.0 verification note.
set -eu
url='https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13-setup.exe'
want='db9a1038bbc0e53fef24f423fd609979bd578e942f1be1198db186d1c42652a3'
dest="${RUNNER_TEMP:-/tmp}/nsis-3.13-setup.exe"
curl -fsSL -L -o "$dest" "$url"
# GNU sha256sum prefixes the line with a backslash when the path contains one,
# which Windows RUNNER_TEMP does. The digest is the first field either way.
got=$(sha256sum "$dest" | awk '{sub(/^\\/, "", $1); print $1}')
if [ "$got" != "$want" ]; then
  echo "nsis-3.13-setup.exe sha256 $got, expected $want" >&2
  exit 1
fi
# Git bash on the Windows runner is not Linux. A Linux checkout only proves the pin.
if [ "$(uname -s)" = "Linux" ]; then
  exit 0
fi
# Git bash would rewrite /S into a filesystem path.
MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -Command "& '$dest' /S"
if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' 'C:\Program Files (x86)\NSIS' >> "$GITHUB_PATH"
fi
