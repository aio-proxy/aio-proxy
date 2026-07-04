#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");

const pkg = `@aio-proxy/cli-${process.platform}-${process.arch}`;
let binary;
try {
  binary = require.resolve(`${pkg}/bin/aio-proxy`);
} catch {
  console.error(
    `aio-proxy: no prebuilt binary for ${process.platform}-${process.arch}.\n` +
      `Expected optional dependency ${pkg} to be installed.`,
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
