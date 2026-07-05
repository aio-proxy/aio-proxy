# Provider config uses object input and array runtime output

User config defines `providers` as an object keyed by Provider ID, because every configured provider needs a stable identifier for routing, dashboard state, auth, and probes. The parsed config still exposes providers as an array so existing runtime routing can keep consuming ordered candidates; the schema injects the object key as `id` and sorts by descending provider weight, preserving config key order for ties.

This keeps user input explicit without spreading object-map handling through the router. The trade-off is that user-visible parsed config APIs return the normalized array form, not the original file shape.
