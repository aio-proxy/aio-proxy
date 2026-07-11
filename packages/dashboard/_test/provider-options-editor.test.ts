import { describe, expect, test } from "bun:test";
import { commitProviderPackageOnce } from "../src/modules/providers/components/provider-form-fields-ai-sdk";
import {
  canConfirmProviderInstall,
  canRequestProviderInstall,
  isProviderOptionsObject,
  providerOptionsAreValid,
} from "../src/modules/providers/components/provider-options-editor";
import {
  initialProviderOptionsSchemaState,
  providerOptionsSchemaTransition,
  providerSchemaRefetchEvent,
  providerStatusRefetchEvent,
} from "../src/modules/providers/hooks/use-provider-options-schema";
import {
  ProviderPackageRequestError,
  providerInstallRequestBody,
  providerOptionsSchemaQueryOptions,
  providerPackageStatusQueryOptions,
  throwRequestError,
} from "../src/modules/providers/services/provider-options-schema-service";

describe("provider options editor", () => {
  test("wires schema workflow, package commit events, and the JSON editor", async () => {
    const aiSdkFieldsSource = await Bun.file(
      `${import.meta.dir}/../src/modules/providers/components/provider-form-fields-ai-sdk.tsx`,
    ).text();
    const optionsEditorSource = await Bun.file(
      `${import.meta.dir}/../src/modules/providers/components/provider-options-editor.tsx`,
    ).text();

    expect(aiSdkFieldsSource).toContain("useProviderOptionsSchema");
    expect(aiSdkFieldsSource).toContain("onBlur");
    expect(aiSdkFieldsSource).toContain('event.key === "Enter"');
    expect(optionsEditorSource).toContain("<JsonEditor");
    expect(optionsEditorSource).toContain("AlertDialog");
    expect(optionsEditorSource).not.toContain("Textarea");
    expect(optionsEditorSource).toContain('schemaState.phase === "schema_unavailable"');
    expect(optionsEditorSource).toContain("options_schema_load_error");
    expect(optionsEditorSource).not.toContain(
      'schemaState.phase === "schema_unavailable" || schemaState.phase === "schema_error"',
    );
  });

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

  test("blocks pending schema workflow phases but allows warning and unavailable fallbacks", () => {
    const validNoSchema = { valid: true, syntaxValid: true, pending: false, markers: [], schema: undefined };
    const invalidNoSchema = { ...validNoSchema, valid: false };

    expect(providerOptionsAreValid(true, validNoSchema, "idle", undefined, "unknown")).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, "checking", undefined, "unknown")).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, "installing", undefined, "loading")).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, "install_required", undefined, "loading")).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, "loading_schema", undefined, "loading")).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, "schema_error", undefined, "error")).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, "ready", undefined, "ready")).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, "schema_unavailable", undefined, "unavailable")).toBe(true);
    expect(providerOptionsAreValid(true, validNoSchema, "install_error", undefined, "unavailable")).toBe(true);
    expect(providerOptionsAreValid(false, validNoSchema, "schema_unavailable", undefined, "unavailable")).toBe(false);
    expect(providerOptionsAreValid(true, invalidNoSchema, "schema_unavailable", undefined, "unavailable")).toBe(false);
  });

  test("keeps embedded schema resolution independent from a failed trusted install", () => {
    const schema = { type: "object", required: ["apiKey"] };
    const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: "package_committed",
      packageName: "@ai-sdk/example",
    });
    const missing = providerOptionsSchemaTransition(committed, {
      type: "status_loaded",
      packageName: "@ai-sdk/example",
      generation: 1,
      status: { trusted: true, state: "missing", schemaAvailable: true },
    });
    const installing = providerOptionsSchemaTransition(missing, { type: "install_started" });
    const failed = providerOptionsSchemaTransition(installing, {
      type: "install_failed",
      packageName: "@ai-sdk/example",
      generation: 1,
      errorCode: "install_failed",
    });
    const validNoSchema = { valid: true, syntaxValid: true, pending: false, markers: [], schema: undefined };

    expect(failed).toMatchObject({ phase: "install_error", schemaResolution: "loading", schema: undefined });
    expect(providerOptionsAreValid(true, validNoSchema, failed.phase, failed.schema, failed.schemaResolution)).toBe(
      false,
    );

    const loaded = providerOptionsSchemaTransition(failed, {
      type: "schema_loaded",
      packageName: "@ai-sdk/example",
      generation: 1,
      schema,
      warnings: [],
    });
    const schemaError = {
      valid: false,
      syntaxValid: true,
      pending: false,
      markers: [{ severity: "error" as const }],
      schema,
    };
    const schemaValid = { ...schemaError, valid: true, markers: [] };

    expect(loaded).toMatchObject({ phase: "install_error", schemaResolution: "ready", schema });
    expect(providerOptionsAreValid(true, schemaError, loaded.phase, loaded.schema, loaded.schemaResolution)).toBe(
      false,
    );
    expect(providerOptionsAreValid(true, schemaValid, loaded.phase, loaded.schema, loaded.schemaResolution, {})).toBe(
      true,
    );

    const loadedBeforeFailure = providerOptionsSchemaTransition(installing, {
      type: "schema_loaded",
      packageName: "@ai-sdk/example",
      generation: 1,
      schema,
      warnings: [],
    });
    expect(
      providerOptionsSchemaTransition(loadedBeforeFailure, {
        type: "install_failed",
        packageName: "@ai-sdk/example",
        generation: 1,
        errorCode: "install_failed",
      }),
    ).toMatchObject({ phase: "install_error", schemaResolution: "ready", schema });
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
      packageName: "@ai-sdk/schema-less",
    });
    const missing = providerOptionsSchemaTransition(committed, {
      type: "status_loaded",
      packageName: "@ai-sdk/schema-less",
      generation: 1,
      status: { trusted: true, state: "missing", schemaAvailable: false },
    });
    const installing = providerOptionsSchemaTransition(missing, { type: "install_started" });
    const failed = providerOptionsSchemaTransition(installing, {
      type: "install_failed",
      packageName: "@ai-sdk/schema-less",
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

  test("ai-sdk pages start with Save blocked until options validity reports", async () => {
    const pageSource = await Bun.file(
      `${import.meta.dir}/../src/modules/providers/templates/provider-form-page.tsx`,
    ).text();

    expect(pageSource).toContain('useState(kind === "api")');
  });

  test("initial package synchronization checks without authorizing trusted auto-install", async () => {
    const aiSdkFieldsSource = await Bun.file(
      `${import.meta.dir}/../src/modules/providers/components/provider-form-fields-ai-sdk.tsx`,
    ).text();

    expect(aiSdkFieldsSource).toContain("initialPackageSynchronized");
    expect(aiSdkFieldsSource).toContain("commitUserPackage");

    const initialCommit = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: "package_committed",
      packageName: "@ai-sdk/openai",
      allowAutomaticInstall: false,
    });
    const initialMissing = providerOptionsSchemaTransition(initialCommit, {
      type: "status_loaded",
      packageName: "@ai-sdk/openai",
      generation: 1,
      status: { trusted: true, state: "missing", schemaAvailable: true },
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
        status: { trusted: true, state: "missing", schemaAvailable: true },
      }),
    ).toMatchObject({ phase: "installing", effect: { type: "install", confirmed: false } });
  });

  test("deferred and failed installs expose an explicit retry action", async () => {
    const optionsEditorSource = await Bun.file(
      `${import.meta.dir}/../src/modules/providers/components/provider-options-editor.tsx`,
    ).text();

    expect(canRequestProviderInstall("install_required")).toBe(true);
    expect(canRequestProviderInstall("install_deferred")).toBe(true);
    expect(canRequestProviderInstall("install_error")).toBe(true);
    expect(canRequestProviderInstall("installing")).toBe(false);
    expect(optionsEditorSource).toContain("schemaState.requestInstall()");
  });
});

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
  test("fresh status errors win over cached status data", () => {
    expect(
      providerStatusRefetchEvent("@ai-sdk/openai", 2, {
        data: { npm: "@ai-sdk/openai", trusted: true, state: "installed", schemaAvailable: true },
        error: new ProviderPackageRequestError(502, "status_upstream_failed"),
      }),
    ).toEqual({
      type: "status_failed",
      packageName: "@ai-sdk/openai",
      generation: 2,
      errorCode: "status_upstream_failed",
    });
  });

  test("fresh schema errors win over cached schema data", () => {
    expect(
      providerSchemaRefetchEvent("@ai-sdk/openai", 3, {
        data: { schema: { type: "object" }, warnings: [] },
        error: new ProviderPackageRequestError(503, "schema_upstream_failed"),
      }),
    ).toEqual({
      type: "schema_failed",
      packageName: "@ai-sdk/openai",
      generation: 3,
      errorCode: "schema_upstream_failed",
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

    const installingWithSchema = {
      ...current,
      phase: "install_error" as const,
      schemaResolution: "loading" as const,
    };
    expect(
      providerOptionsSchemaTransition(installingWithSchema, {
        type: "schema_loaded",
        packageName: "@ai-sdk/openai",
        generation: 1,
        schema: { type: "object" },
        warnings: [],
      }),
    ).toBe(installingWithSchema);
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
