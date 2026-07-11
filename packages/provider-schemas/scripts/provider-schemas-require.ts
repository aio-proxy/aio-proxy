const { createRequire } = process.getBuiltinModule("node:module") as typeof import("node:module");

export const providerSchemasRequire = (() => {
  for (const filename of [`${process.cwd()}/package.json`, `${process.cwd()}/packages/provider-schemas/package.json`]) {
    const candidate = createRequire(filename);
    try {
      candidate.resolve("@babel/parser");
      return candidate;
    } catch {}
  }
  throw new Error("Cannot resolve provider schema build dependencies");
})();
