import { describe, expect, test } from "bun:test";
import {
  initialProviderOptionsSchemaState,
  providerOptionsSchemaTransition,
} from "../src/modules/providers/hooks/use-provider-options-schema";
import {
  ProviderPackageRequestError,
  providerInstallRequestBody,
  providerOptionsSchemaQueryOptions,
  providerPackageStatusQueryOptions,
  throwRequestError,
} from "../src/modules/providers/services/provider-options-schema-service";

describe("provider options schema service", () => {
  test("package status and schema query keys include the package", () => {
    expect(providerPackageStatusQueryOptions("@ai-sdk/openai").queryKey).toEqual([
      "providers",
      "package-status",
      "@ai-sdk/openai",
    ]);
    expect(providerOptionsSchemaQueryOptions("@ai-sdk/google").queryKey).toEqual([
      "providers",
      "options-schema",
      "@ai-sdk/google",
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
        { ...initialProviderOptionsSchemaState, phase: "checking", committedPackage: "@ai-sdk/google" },
        {
          type: "status_loaded",
          packageName: "@ai-sdk/google",
          generation: 0,
          status: { trusted: true, state: "missing", schemaAvailable: true },
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
        status: { trusted: false, state: "missing", schemaAvailable: true },
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
      { ...initialProviderOptionsSchemaState, phase: "checking", committedPackage: "with-schema" },
      {
        type: "status_loaded",
        packageName: "with-schema",
        generation: 0,
        status: { trusted: false, state: "installed", schemaAvailable: true },
      },
    );
    const installedWithoutSchema = providerOptionsSchemaTransition(
      { ...initialProviderOptionsSchemaState, phase: "checking", committedPackage: "without-schema" },
      {
        type: "status_loaded",
        packageName: "without-schema",
        generation: 0,
        status: { trusted: true, state: "installed", schemaAvailable: false },
      },
    );

    expect(installedWithSchema.phase).toBe("loading_schema");
    expect(installedWithoutSchema.phase).toBe("schema_unavailable");
  });

  test("async completions for an old package are ignored", () => {
    const current = {
      ...initialProviderOptionsSchemaState,
      phase: "loading_schema" as const,
      committedPackage: "@ai-sdk/google",
    };

    expect(
      providerOptionsSchemaTransition(current, {
        type: "schema_loaded",
        packageName: "@ai-sdk/openai",
        generation: 0,
        schema: { type: "string" },
        warnings: [],
      }),
    ).toBe(current);
    expect(
      providerOptionsSchemaTransition(current, {
        type: "install_failed",
        packageName: "@ai-sdk/openai",
        generation: 0,
        errorCode: "install_failed",
      }),
    ).toBe(current);
  });

  test("schema missing is an explicit fallback state", () => {
    expect(
      providerOptionsSchemaTransition(
        { ...initialProviderOptionsSchemaState, phase: "loading_schema", committedPackage: "schema-less" },
        { type: "schema_missing", packageName: "schema-less", generation: 0 },
      ),
    ).toMatchObject({ phase: "schema_unavailable", schema: undefined, warnings: [] });
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
      schema: undefined,
    });
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
        status: { trusted: true, state: "installed", schemaAvailable: true },
      }),
    ).toBe(current);
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
        status: { trusted: true, state: "missing", schemaAvailable: true },
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
      status: { trusted: true, state: "missing", schemaAvailable: true },
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
        status: { trusted: true, state: "missing", schemaAvailable: true },
      }),
    ).toMatchObject({
      phase: "install_error",
      automaticInstallAttempted: true,
      effect: undefined,
      errorCode: "package_still_missing",
    });
  });

  test("transient schema errors do not enable schema-less fallback", () => {
    expect(
      providerOptionsSchemaTransition(
        {
          ...initialProviderOptionsSchemaState,
          phase: "loading_schema",
          committedPackage: "@ai-sdk/openai",
          commitGeneration: 1,
        },
        {
          type: "schema_failed",
          packageName: "@ai-sdk/openai",
          generation: 1,
          errorCode: "request_failed",
        },
      ),
    ).toMatchObject({ phase: "schema_error", schema: undefined, errorCode: "request_failed" });
  });
});
