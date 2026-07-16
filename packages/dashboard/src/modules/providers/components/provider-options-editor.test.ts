import { describe, expect, test } from "@rstest/core";
import {
  initialProviderOptionsSchemaState,
  providerOptionsSchemaTransition,
  providerStatusRefetchEvent,
} from "../hooks/use-provider-options-schema";
import {
  ProviderPackageRequestError,
  providerInstallRequestBody,
  providerPackageStatusQueryOptions,
  throwRequestError,
} from "../services/provider-options-schema-service";
import { commitProviderPackageOnce } from "./provider-form-fields-ai-sdk";
import {
  canConfirmProviderInstall,
  canRequestProviderInstall,
  isProviderOptionsObject,
  providerOptionsAreValid,
} from "./provider-options-editor";

describe("provider options editor", () => {
  test("accepts only undefined or a plain object at the provider options root", () => {
    expect(isProviderOptionsObject(undefined)).toBe(true);
    expect(isProviderOptionsObject({})).toBe(true);
    expect(isProviderOptionsObject({ baseURL: "https://example.com" })).toBe(true);
    expect(isProviderOptionsObject([])).toBe(false);
    expect(isProviderOptionsObject(null)).toBe(false);
    expect(isProviderOptionsObject(true)).toBe(false);
    expect(isProviderOptionsObject(42)).toBe(false);
    expect(isProviderOptionsObject("value")).toBe(false);
  });

  test("commits resolve the local catalog schema immediately", () => {
    const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: "package_committed",
      packageName: "@ai-sdk/openai-compatible",
    });
    expect(committed).toMatchObject({
      phase: "checking",
      schemaResolution: "ready",
      schemaPackage: "@ai-sdk/openai-compatible",
    });
    expect(committed.schema).toBeDefined();

    const unknown = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: "package_committed",
      packageName: "@vendor/custom-provider",
    });
    expect(unknown).toMatchObject({
      phase: "checking",
      schemaResolution: "unavailable",
      schema: undefined,
      schemaPackage: null,
    });
  });

  test("blocks pending schema workflow phases but allows warning and unavailable fallbacks", () => {
    const validNoSchema = { valid: true, syntaxValid: true, pending: false, markers: [], schema: undefined };
    const invalidNoSchema = { ...validNoSchema, valid: false };

    expect(providerOptionsAreValid(true, validNoSchema, "idle", undefined, "unknown")).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, "checking", undefined, "unknown")).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, "installing", undefined, "unavailable")).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, "install_required", undefined, "unavailable")).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, "ready", undefined, "ready")).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, "schema_unavailable", undefined, "unavailable")).toBe(true);
    expect(providerOptionsAreValid(true, validNoSchema, "install_error", undefined, "unavailable")).toBe(true);
    expect(providerOptionsAreValid(false, validNoSchema, "schema_unavailable", undefined, "unavailable")).toBe(false);
    expect(providerOptionsAreValid(true, invalidNoSchema, "schema_unavailable", undefined, "unavailable")).toBe(false);
  });

  test("keeps embedded schema resolution independent from a failed trusted install", () => {
    const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: "package_committed",
      packageName: "@ai-sdk/openai-compatible",
    });
    expect(committed).toMatchObject({ phase: "checking", schemaResolution: "ready" });
    expect(committed.schema).toBeDefined();

    const missing = providerOptionsSchemaTransition(committed, {
      type: "status_loaded",
      packageName: "@ai-sdk/openai-compatible",
      generation: 1,
      status: { trusted: true, state: "missing" },
    });
    const installing = providerOptionsSchemaTransition(missing, { type: "install_started" });
    const failed = providerOptionsSchemaTransition(installing, {
      type: "install_failed",
      packageName: "@ai-sdk/openai-compatible",
      generation: 1,
      errorCode: "install_failed",
    });

    expect(failed).toMatchObject({ phase: "install_error", schemaResolution: "ready", errorCode: "install_failed" });
    expect(failed.schema).toBeDefined();

    const schemaError = {
      valid: false,
      syntaxValid: true,
      pending: false,
      markers: [{ severity: "error" as const }],
      schema: failed.schema,
    };
    const schemaValid = { ...schemaError, valid: true, markers: [] };

    expect(providerOptionsAreValid(true, schemaError, failed.phase, failed.schema, failed.schemaResolution)).toBe(
      false,
    );
    expect(providerOptionsAreValid(true, schemaValid, failed.phase, failed.schema, failed.schemaResolution, {})).toBe(
      true,
    );
  });

  test("blocks status failures including invalid package names", () => {
    const validNoSchema = { valid: true, syntaxValid: true, pending: false, markers: [], schema: undefined };
    for (const errorCode of ["request_failed", "invalid_package_name"]) {
      const packageName = errorCode === "invalid_package_name" ? "../bad" : "@ai-sdk/example";
      const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
        type: "package_committed",
        packageName,
      });
      const failed = providerOptionsSchemaTransition(committed, {
        type: "status_failed",
        packageName,
        generation: 1,
        errorCode,
      });

      expect(failed).toMatchObject({ phase: "status_error", schemaResolution: "error", errorCode });
      expect(providerOptionsAreValid(true, validNoSchema, failed.phase, failed.schema, failed.schemaResolution)).toBe(
        false,
      );
    }
  });

  test("allows schema-less fallback after a failed install only once unavailability is explicit", () => {
    const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: "package_committed",
      packageName: "@vendor/custom-provider",
    });
    expect(committed).toMatchObject({ phase: "checking", schemaResolution: "unavailable", schema: undefined });

    const missing = providerOptionsSchemaTransition(committed, {
      type: "status_loaded",
      packageName: "@vendor/custom-provider",
      generation: 1,
      status: { trusted: true, state: "missing" },
    });
    const installing = providerOptionsSchemaTransition(missing, { type: "install_started" });
    const failed = providerOptionsSchemaTransition(installing, {
      type: "install_failed",
      packageName: "@vendor/custom-provider",
      generation: 1,
      errorCode: "install_failed",
    });
    const validNoSchema = { valid: true, syntaxValid: true, pending: false, markers: [], schema: undefined };

    expect(failed).toMatchObject({
      phase: "install_error",
      schemaResolution: "unavailable",
      errorCode: "install_failed",
    });
    expect(providerOptionsAreValid(true, validNoSchema, failed.phase, failed.schema, failed.schemaResolution)).toBe(
      true,
    );
  });

  test("blocks ready until validation belongs to the loaded schema", () => {
    const schema = { type: "object" };
    const oldValidation = { valid: true, syntaxValid: true, pending: false, markers: [], schema: undefined };
    const currentValidation = { ...oldValidation, schema };

    expect(providerOptionsAreValid(true, oldValidation, "ready", schema, "ready")).toBe(false);
    expect(providerOptionsAreValid(true, currentValidation, "ready", schema, "ready")).toBe(true);
  });

  test("blank options are invalid when the loaded schema requires root fields", () => {
    const schema = { type: "object", required: ["name", "baseURL"] };
    const optionalSchema = { type: "object", required: [] };
    const validation = { valid: true, syntaxValid: true, pending: false, markers: [], schema };

    expect(providerOptionsAreValid(true, validation, "ready", schema, "ready", undefined)).toBe(false);
    expect(providerOptionsAreValid(true, validation, "ready", schema, "ready", {})).toBe(true);
    expect(
      providerOptionsAreValid(
        true,
        { ...validation, schema: optionalSchema },
        "ready",
        optionalSchema,
        "ready",
        undefined,
      ),
    ).toBe(true);
  });

  test("only confirms the install-required package currently bound to the dialog", () => {
    expect(canConfirmProviderInstall("community-provider", "install_required", "community-provider")).toBe(true);
    expect(canConfirmProviderInstall("old-provider", "install_required", "new-provider")).toBe(false);
    expect(canConfirmProviderInstall("community-provider", "checking", "community-provider")).toBe(false);
    expect(canConfirmProviderInstall(null, "install_required", "community-provider")).toBe(false);
  });

  test("routine package commits ignore StrictMode and Enter-then-blur repeats", () => {
    const committed = { current: null as string | null };
    const packages: string[] = [];
    const commit = (packageName: string) => packages.push(packageName);

    expect(commitProviderPackageOnce("@ai-sdk/openai", committed, commit)).toBe(true);
    expect(commitProviderPackageOnce("@ai-sdk/openai", committed, commit)).toBe(false);
    expect(packages).toEqual(["@ai-sdk/openai"]);

    committed.current = null;
    expect(commitProviderPackageOnce("@ai-sdk/openai", committed, commit)).toBe(true);
    expect(packages).toEqual(["@ai-sdk/openai", "@ai-sdk/openai"]);
  });

  test("initial package synchronization checks without authorizing trusted auto-install", () => {
    const initialCommit = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: "package_committed",
      packageName: "@ai-sdk/openai",
      allowAutomaticInstall: false,
    });
    const initialMissing = providerOptionsSchemaTransition(initialCommit, {
      type: "status_loaded",
      packageName: "@ai-sdk/openai",
      generation: 1,
      status: { trusted: true, state: "missing" },
    });

    expect(initialMissing).toMatchObject({ phase: "install_deferred", effect: undefined });

    const userCommit = providerOptionsSchemaTransition(initialMissing, {
      type: "package_committed",
      packageName: "@ai-sdk/openai",
      allowAutomaticInstall: true,
    });
    expect(
      providerOptionsSchemaTransition(userCommit, {
        type: "status_loaded",
        packageName: "@ai-sdk/openai",
        generation: 2,
        status: { trusted: true, state: "missing" },
      }),
    ).toMatchObject({ phase: "installing", effect: { type: "install", confirmed: false } });
  });

  test("deferred and failed installs expose an explicit retry action", () => {
    expect(canRequestProviderInstall("install_required")).toBe(true);
    expect(canRequestProviderInstall("install_deferred")).toBe(true);
    expect(canRequestProviderInstall("install_error")).toBe(true);
    expect(canRequestProviderInstall("installing")).toBe(false);
  });
});

describe("provider options schema service", () => {
  test("package status query key includes the package", () => {
    expect(providerPackageStatusQueryOptions("@ai-sdk/openai").queryKey).toEqual([
      "providers",
      "package-status",
      "@ai-sdk/openai",
    ]);
  });

  test("install requests omit false confirmation and include confirmed untrusted consent", () => {
    expect(providerInstallRequestBody("@ai-sdk/openai", false)).toEqual({ npm: "@ai-sdk/openai" });
    expect(providerInstallRequestBody("community-provider", true)).toEqual({
      npm: "community-provider",
      confirmed: true,
    });
  });

  test("non-JSON error responses still produce a typed request error", async () => {
    const error = await throwRequestError(new Response("upstream exploded", { status: 502 })).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ProviderPackageRequestError);
    expect(error).toMatchObject({ status: 502, code: "request_failed" });
  });
});

describe("provider options schema workflow", () => {
  test("retrying a deferred trusted install starts a fresh automatic attempt", () => {
    const initialCommit = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: "package_committed",
      packageName: "@ai-sdk/openai",
      allowAutomaticInstall: false,
    });
    const deferred = providerOptionsSchemaTransition(initialCommit, {
      type: "status_loaded",
      packageName: "@ai-sdk/openai",
      generation: 1,
      status: { trusted: true, state: "missing" },
    });
    const retry = providerOptionsSchemaTransition(deferred, {
      type: "package_committed",
      packageName: "@ai-sdk/openai",
      allowAutomaticInstall: true,
    });

    expect(retry).toMatchObject({
      phase: "checking",
      committedPackage: "@ai-sdk/openai",
      commitGeneration: 2,
    });
    expect(
      providerOptionsSchemaTransition(retry, {
        type: "status_loaded",
        packageName: "@ai-sdk/openai",
        generation: 2,
        status: { trusted: true, state: "missing" },
      }),
    ).toMatchObject({ phase: "installing", effect: { type: "install", confirmed: false } });
  });

  test("retrying a failed untrusted install returns to confirmation before reinstalling", () => {
    const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: "package_committed",
      packageName: "community-provider",
    });
    const required = providerOptionsSchemaTransition(committed, {
      type: "status_loaded",
      packageName: "community-provider",
      generation: 1,
      status: { trusted: false, state: "missing" },
    });
    const installing = providerOptionsSchemaTransition(
      providerOptionsSchemaTransition(required, { type: "install_confirmed" }),
      { type: "install_started" },
    );
    const failed = providerOptionsSchemaTransition(installing, {
      type: "install_failed",
      packageName: "community-provider",
      generation: 1,
      errorCode: "install_failed",
    });
    const retry = providerOptionsSchemaTransition(failed, {
      type: "package_committed",
      packageName: "community-provider",
      allowAutomaticInstall: true,
    });
    const retryRequired = providerOptionsSchemaTransition(retry, {
      type: "status_loaded",
      packageName: "community-provider",
      generation: 2,
      status: { trusted: false, state: "missing" },
    });

    expect(retry).toMatchObject({ phase: "checking", commitGeneration: 2 });
    expect(retryRequired).toMatchObject({ phase: "install_required", effect: undefined });
    expect(providerOptionsSchemaTransition(retryRequired, { type: "install_confirmed" })).toMatchObject({
      phase: "installing",
      effect: { type: "install", confirmed: true },
    });
  });

  test("retry ignores completions from the previous install generation", () => {
    const retry = providerOptionsSchemaTransition(
      {
        ...initialProviderOptionsSchemaState,
        phase: "install_error",
        committedPackage: "@ai-sdk/openai",
        commitGeneration: 1,
        errorCode: "install_failed",
      },
      { type: "package_committed", packageName: "@ai-sdk/openai", allowAutomaticInstall: true },
    );

    expect(
      providerOptionsSchemaTransition(retry, {
        type: "install_succeeded",
        packageName: "@ai-sdk/openai",
        generation: 1,
      }),
    ).toBe(retry);
  });

  test("fresh status errors win over cached status data", () => {
    expect(
      providerStatusRefetchEvent("@ai-sdk/openai", 2, {
        data: { npm: "@ai-sdk/openai", trusted: true, state: "installed" },
        error: new ProviderPackageRequestError(502, "status_upstream_failed"),
      }),
    ).toEqual({
      type: "status_failed",
      packageName: "@ai-sdk/openai",
      generation: 2,
      errorCode: "status_upstream_failed",
    });
  });

  test("package change clears schema before the next commit", () => {
    expect(
      providerOptionsSchemaTransition(
        {
          ...initialProviderOptionsSchemaState,
          phase: "ready",
          committedPackage: "@ai-sdk/openai",
          schemaPackage: "@ai-sdk/openai",
          schema: { type: "object" },
          commitGeneration: 1,
        },
        { type: "package_changed", packageName: "@ai-sdk/google" },
      ),
    ).toMatchObject({ phase: "idle", committedPackage: null, schemaPackage: null, schema: undefined });
  });

  test("trusted missing packages request automatic install", () => {
    expect(
      providerOptionsSchemaTransition(
        {
          ...initialProviderOptionsSchemaState,
          phase: "checking",
          committedPackage: "@ai-sdk/google",
          allowAutomaticInstall: true,
        },
        {
          type: "status_loaded",
          packageName: "@ai-sdk/google",
          generation: 0,
          status: { trusted: true, state: "missing" },
        },
      ),
    ).toMatchObject({ phase: "installing", effect: { type: "install", confirmed: false } });
  });

  test("untrusted missing packages wait for explicit confirmation", () => {
    const required = providerOptionsSchemaTransition(
      { ...initialProviderOptionsSchemaState, phase: "checking", committedPackage: "community-provider" },
      {
        type: "status_loaded",
        packageName: "community-provider",
        generation: 0,
        status: { trusted: false, state: "missing" },
      },
    );

    expect(required).toMatchObject({ phase: "install_required", effect: undefined });
    const confirmed = providerOptionsSchemaTransition(required, { type: "install_confirmed" });
    expect(confirmed).toMatchObject({
      phase: "installing",
      effect: { type: "install", confirmed: true },
    });
    expect(providerOptionsSchemaTransition(confirmed, { type: "install_started" })).toMatchObject({
      effect: undefined,
      automaticInstallAttempted: false,
    });
  });

  test("schema availability is independent of package install state", () => {
    const installedWithSchema = providerOptionsSchemaTransition(
      providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
        type: "package_committed",
        packageName: "@ai-sdk/openai-compatible",
      }),
      {
        type: "status_loaded",
        packageName: "@ai-sdk/openai-compatible",
        generation: 1,
        status: { trusted: false, state: "installed" },
      },
    );
    const installedWithoutSchema = providerOptionsSchemaTransition(
      providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
        type: "package_committed",
        packageName: "@vendor/custom-provider",
      }),
      {
        type: "status_loaded",
        packageName: "@vendor/custom-provider",
        generation: 1,
        status: { trusted: true, state: "installed" },
      },
    );

    expect(installedWithSchema.phase).toBe("ready");
    expect(installedWithoutSchema.phase).toBe("schema_unavailable");
  });

  test("async completions for an old package are ignored", () => {
    const current = {
      ...initialProviderOptionsSchemaState,
      phase: "checking" as const,
      committedPackage: "@ai-sdk/google",
      commitGeneration: 1,
    };

    expect(
      providerOptionsSchemaTransition(current, {
        type: "status_loaded",
        packageName: "@ai-sdk/openai",
        generation: 1,
        status: { trusted: true, state: "installed" },
      }),
    ).toBe(current);
    expect(
      providerOptionsSchemaTransition(current, {
        type: "install_failed",
        packageName: "@ai-sdk/openai",
        generation: 1,
        errorCode: "install_failed",
      }),
    ).toBe(current);
  });

  test("same-package recommit increments generation and restarts status synchronization", () => {
    const committed = providerOptionsSchemaTransition(
      {
        ...initialProviderOptionsSchemaState,
        phase: "ready",
        committedPackage: "@ai-sdk/openai",
        commitGeneration: 3,
        schemaPackage: "@ai-sdk/openai",
        schema: { type: "object" },
      },
      { type: "package_committed", packageName: "@ai-sdk/openai" },
    );

    expect(committed).toMatchObject({
      phase: "checking",
      committedPackage: "@ai-sdk/openai",
      commitGeneration: 4,
      schemaResolution: "ready",
    });
    expect(committed.schema).toBeDefined();
  });

  test("same-package completions from an older generation are ignored", () => {
    const current = {
      ...initialProviderOptionsSchemaState,
      phase: "checking" as const,
      committedPackage: "@ai-sdk/openai",
      commitGeneration: 2,
    };

    expect(
      providerOptionsSchemaTransition(current, {
        type: "status_loaded",
        packageName: "@ai-sdk/openai",
        generation: 1,
        status: { trusted: true, state: "installed" },
      }),
    ).toBe(current);

    const installing = { ...current, phase: "installing" as const };
    expect(
      providerOptionsSchemaTransition(installing, {
        type: "install_succeeded",
        packageName: "@ai-sdk/openai",
        generation: 1,
      }),
    ).toBe(installing);
  });

  test("phase-inappropriate completions are ignored", () => {
    const current = {
      ...initialProviderOptionsSchemaState,
      phase: "ready" as const,
      committedPackage: "@ai-sdk/openai",
      commitGeneration: 1,
      schemaPackage: "@ai-sdk/openai",
      schema: { type: "object" },
    };

    expect(
      providerOptionsSchemaTransition(current, {
        type: "status_loaded",
        packageName: "@ai-sdk/openai",
        generation: 1,
        status: { trusted: true, state: "missing" },
      }),
    ).toBe(current);
  });

  test("trusted package still missing after one automatic attempt enters an explicit error", () => {
    const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: "package_committed",
      packageName: "@ai-sdk/openai",
    });
    const missing = providerOptionsSchemaTransition(committed, {
      type: "status_loaded",
      packageName: "@ai-sdk/openai",
      generation: 1,
      status: { trusted: true, state: "missing" },
    });
    const installing = providerOptionsSchemaTransition(missing, { type: "install_started" });
    const checking = providerOptionsSchemaTransition(installing, {
      type: "install_succeeded",
      packageName: "@ai-sdk/openai",
      generation: 1,
    });

    expect(
      providerOptionsSchemaTransition(checking, {
        type: "status_loaded",
        packageName: "@ai-sdk/openai",
        generation: 1,
        status: { trusted: true, state: "missing" },
      }),
    ).toMatchObject({
      phase: "install_error",
      automaticInstallAttempted: true,
      effect: undefined,
      errorCode: "package_still_missing",
    });
  });
});
