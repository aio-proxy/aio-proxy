#!/usr/bin/env node
"use strict";
const { spawn } = require("node:child_process");

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

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const forwarders = {};
for (const sig of signals) {
  forwarders[sig] = () => {
    try { child.kill(sig); } catch {}
  };
  process.on(sig, forwarders[sig]);
}

child.on("exit", (code, signal) => {
  for (const sig of signals) {
    process.removeListener(sig, forwarders[sig]);
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(typeof code === "number" ? code : 1);
});
