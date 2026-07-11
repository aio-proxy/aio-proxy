// @ts-expect-error Bun supports JSON5 imports for arbitrary file extensions.
import bunLock from "../bun.lock" with { type: "json5" };
// @ts-expect-error Bun supports TOML imports.
import bunfig from "../bunfig.toml";

const { packages } = bunLock as {
  packages: Record<string, [string, string]>;
};
const registryHostname = new URL(bunfig.install.registry).hostname;

for (const [dependency, registry] of Object.values(packages)) {
  if (registry && new URL(registry).hostname !== registryHostname) {
    throw new Error(`${dependency} uses a registry not configured in bunfig.toml: ${registry}`);
  }
}
