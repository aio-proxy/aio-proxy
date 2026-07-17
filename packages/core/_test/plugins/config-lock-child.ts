import { AtomicConfigFile } from "../../src/plugins/config-file";

const [mode, path, key, value] = process.argv.slice(2);
if (mode === undefined || path === undefined) throw new Error("missing arguments");
const config = new AtomicConfigFile(path);

if (mode === "update") {
  if (key === undefined) throw new Error("missing key");
  await config.replace(async (current) => {
    await Bun.sleep(100);
    return { ...current, [key]: value };
  });
  console.log("updated");
} else if (mode === "hold") {
  await config.transaction(async (current) => {
    console.log("locked");
    await new Promise(() => {});
    return { next: current, result: undefined };
  });
} else {
  throw new Error(`unknown mode ${mode}`);
}
