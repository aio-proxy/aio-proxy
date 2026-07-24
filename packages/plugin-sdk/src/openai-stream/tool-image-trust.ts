// One realm-scoped capability survives duplicate module instances without a growing token registry.
const trustTokenKey = Symbol.for("@aio-proxy/plugin-sdk/tool-image-trust/v1");

export type ToolImageMarker = {
  readonly toolImage: true;
  readonly trust: string;
};

export function createToolImageMarker(): ToolImageMarker {
  return { toolImage: true, trust: trustToken() };
}

export function isTrustedToolImageMarker(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.get(value, "toolImage") === true &&
    Reflect.get(value, "trust") === trustToken()
  );
}

function trustToken(): string {
  const existing = Reflect.get(globalThis, trustTokenKey);
  if (typeof existing === "string") return existing;
  const created = crypto.randomUUID();
  Object.defineProperty(globalThis, trustTokenKey, { value: created });
  return created;
}
