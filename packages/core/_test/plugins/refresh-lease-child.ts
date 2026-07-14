import { zod } from "@aio-proxy/plugin-sdk";
import { openDb } from "../../src/db";
import { createCredentialPort } from "../../src/plugins/credential-port";
import { createPluginRepository } from "../../src/plugins/repository";

const [mode, home, providerId, argument] = process.argv.slice(2);
if (mode === undefined || home === undefined || providerId === undefined) {
  throw new Error("usage: refresh-lease-child.ts <mode> <home> <provider-id> [argument]");
}

const handle = openDb({ home });
const repository = createPluginRepository(handle.sqlite);

try {
  if (mode === "hold") {
    const owner = `${process.pid}:killed-owner`;
    const ttlMs = Number(argument ?? "200");
    if (!repository.tryAcquireRefreshLease(providerId, owner, Date.now(), Date.now() + ttlMs)) {
      throw new Error("failed to acquire lease");
    }
    console.log("acquired");
    await new Promise(() => {});
  } else if (mode === "refresh") {
    const port = createCredentialPort({
      providerId,
      schema: zod.object({ token: zod.string() }),
      repository,
      diagnostics: (code, options) => ({
        code,
        summary: "Credential refresh failed",
        retryable: options.retryable,
        occurredAt: "2026-07-15T00:00:00.000Z",
      }),
      logger: () => {},
      onDiagnosticChanged: () => {},
    });
    const current = await port.read();
    const result = await port.refresh(current.revision, async () => {
      console.log("exchange");
      await Bun.sleep(Number(argument ?? "200"));
      return { value: { token: `refreshed-${process.pid}` } };
    });
    console.log(result.status);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally {
  handle.close();
}
