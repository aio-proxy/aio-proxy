const result = Bun.spawnSync(
  [
    "bunx",
    "@inlang/paraglide-js",
    "compile",
    "--project",
    "./project.inlang",
    "--outdir",
    "./src/paraglide",
    "--emit-ts-declarations",
  ],
  {
    cwd: `${import.meta.dir}/..`,
    stderr: "inherit",
    stdout: "inherit",
  },
);

process.exit(result.exitCode);
