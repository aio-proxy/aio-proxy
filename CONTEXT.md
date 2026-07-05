# aio-proxy

aio-proxy routes model requests across configured upstream providers while keeping client-facing protocols stable.

## Language

**Provider ID**:
A stable identifier for an upstream provider. In user config, it is the key in the `providers` object.
_Avoid_: provider name, provider key

**Provider weight**:
A numeric priority for provider selection. Higher weights are tried before lower weights.
_Avoid_: order, rank
