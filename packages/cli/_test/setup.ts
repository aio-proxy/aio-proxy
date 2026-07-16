import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testHome = mkdtempSync(join(tmpdir(), "aio-proxy-cli-tests-"));

process.env.AIO_PROXY_HOME = testHome;
process.on("exit", () => rmSync(testHome, { force: true, recursive: true }));
