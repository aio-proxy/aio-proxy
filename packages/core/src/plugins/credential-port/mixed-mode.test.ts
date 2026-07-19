import { afterEach, expect, test } from "bun:test";
import type { PluginLogSink } from "../diagnostic";
import { createFixtureScope, deferred, port } from "./test-support";

const scope = createFixtureScope();

afterEach(scope.cleanup);

type Mode = "runtime" | "control-plane";

type Observations = {
  diagnosticChanges: number;
  credentialChanges: number;
  readonly logs: Parameters<PluginLogSink>[0][];
};

function otherMode(mode: Mode): Mode {
  return mode === "runtime" ? "control-plane" : "runtime";
}

for (const firstMode of ["runtime", "control-plane"] as const) {
  for (const firstOutcome of ["success", "failure"] as const) {
    test(`${firstMode} refresh ${firstOutcome} keeps mixed-mode policy isolated`, async () => {
      const { handle, repository } = scope.open();
      const secondMode = otherMode(firstMode);
      const observations: Record<Mode, Observations> = {
        runtime: { diagnosticChanges: 0, credentialChanges: 0, logs: [] },
        "control-plane": { diagnosticChanges: 0, credentialChanges: 0, logs: [] },
      };
      const credentials = (mode: Mode) => {
        const observed = observations[mode];
        return port(repository, "provider-1", {
          mode,
          logger: (entry) => observed.logs.push(entry),
          onDiagnosticChanged: () => observed.diagnosticChanges++,
          onCredentialChanged: () => observed.credentialChanges++,
        });
      };

      try {
        if (firstOutcome === "success") {
          repository.writeDiagnostic("provider-1", {
            code: "CREDENTIAL_REFRESH_FAILED",
            summary: "existing",
            retryable: false,
            occurredAt: new Date(0).toISOString(),
          });
        }
        const current = await credentials(firstMode).read();
        const firstStarted = deferred();
        const firstGate = deferred();
        const exchanges: Mode[] = [];
        const failure = new Error(`${firstMode} refresh failed`);
        const exchange = async (mode: Mode, blocked: boolean) => {
          exchanges.push(mode);
          if (blocked) {
            firstStarted.resolve();
            await firstGate.promise;
            if (firstOutcome === "failure") throw failure;
          }
          return {
            value: { token: `${mode}-credential` },
            metadata: { label: `${mode}-label`, expiresAt: mode === "runtime" ? 10 : 20 },
          };
        };

        const firstRefresh = credentials(firstMode).refresh(current.revision, () => exchange(firstMode, true));
        const firstSettled = firstRefresh.then(
          (result) => ({ status: "fulfilled" as const, result }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        await firstStarted.promise;
        const secondRefresh = credentials(secondMode).refresh(current.revision, () => exchange(secondMode, false));
        const secondSettled = secondRefresh.then(
          (result) => ({ status: "fulfilled" as const, result }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        await Promise.resolve();
        firstGate.resolve();

        const [first, second] = await Promise.all([firstSettled, secondSettled]);
        const winnerMode = firstOutcome === "success" ? firstMode : secondMode;
        const expectedSnapshot = {
          value: { token: `${winnerMode}-credential` },
          revision: current.revision + 1,
        };

        if (firstOutcome === "success") {
          expect(first).toEqual({ status: "fulfilled", result: { status: "updated", snapshot: expectedSnapshot } });
          expect(second).toEqual({
            status: "fulfilled",
            result: { status: "superseded", snapshot: expectedSnapshot },
          });
          expect(exchanges).toEqual([firstMode]);
        } else {
          expect(first).toEqual({ status: "rejected", error: failure });
          expect(second).toEqual({ status: "fulfilled", result: { status: "updated", snapshot: expectedSnapshot } });
          expect(exchanges).toEqual([firstMode, secondMode]);
        }

        expect(repository.readAccount("provider-1")).toMatchObject({
          credential: expectedSnapshot.value,
          revision: expectedSnapshot.revision,
          label: `${winnerMode}-label`,
          expiresAt: winnerMode === "runtime" ? 10 : 20,
        });
        const diagnosticCodes = repository.readDiagnostics("provider-1").map(({ code }) => code);
        if (firstMode === "control-plane" && firstOutcome === "success") {
          expect(diagnosticCodes).toEqual(["CREDENTIAL_REFRESH_FAILED"]);
        } else if (firstMode === "runtime" && firstOutcome === "failure") {
          expect(diagnosticCodes).toEqual(["CREDENTIAL_REFRESH_FAILED"]);
        } else {
          expect(diagnosticCodes).toEqual([]);
        }

        expect(observations["control-plane"]).toMatchObject({
          diagnosticChanges: 0,
          credentialChanges: 0,
        });
        expect(observations.runtime.diagnosticChanges).toBe(firstMode === "runtime" ? 1 : 0);
        expect(observations.runtime.credentialChanges).toBe(
          (firstMode === "runtime" && firstOutcome === "success") ||
            (firstMode === "control-plane" && firstOutcome === "failure")
            ? 1
            : 0,
        );
        expect(observations[firstMode].logs).toHaveLength(firstOutcome === "failure" ? 1 : 0);
        expect(observations[secondMode].logs).toHaveLength(0);
      } finally {
        handle.close();
      }
    });
  }
}
