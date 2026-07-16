# @aio-proxy/plugin-sdk

Public contracts for extending aio-proxy with provider and OAuth plugins.

## Runtime compatibility

Plugin runtime hooks execute inside the aio-proxy Bun host. Bun `>=1.3.14` is the v1 runtime compatibility
target. Plugin authors may use Node-based tooling for development and type checking, but execution under Node
or undici is not part of the v1 compatibility promise.
