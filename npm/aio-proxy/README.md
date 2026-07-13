# aio-proxy

All-in-one LLM API proxy with a local dashboard.

## Install

- npm: `npm install -g aio-proxy`
- curl: `curl -fsSL https://raw.githubusercontent.com/baranwang/aio-proxy/main/install.sh | sh`

Then run `aio-proxy serve`.

## Security model

aio-proxy currently trusts the local machine and only accepts `127.0.0.1`, `::1`, or `localhost` as its server
host. Remote binding is deliberately rejected until an authenticated remote mode is designed.
