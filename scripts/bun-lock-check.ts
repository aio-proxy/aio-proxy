import bunLock from "../bun.lock" with { type: "json5" };
import bunfig from "../bunfig.toml";

const { packages } = bunLock;
const registryHostname = new URL(bunfig.install.registry).hostname;

for (const [dependency, registry] of Object.values(packages)) {
  if (registry && typeof registry === "string" && new URL(registry).hostname !== registryHostname) {
    throw new Error(`${dependency} uses a registry not configured in bunfig.toml: ${registry}`);
  }
}
