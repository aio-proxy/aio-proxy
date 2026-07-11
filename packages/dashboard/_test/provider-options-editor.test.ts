import { describe, expect, test } from "bun:test";
import {
  initialProviderOptionsSchemaState,
  providerOptionsSchemaTransition,
} from "../src/modules/providers/hooks/use-provider-options-schema";
import {
  providerOptionsSchemaQueryOptions,
  providerPackageStatusQueryOptions,
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

  test("install requests omit false confirmation and include confirmed untrusted consent", async () => {
    const source = await Bun.file(
      `${import.meta.dir}/../src/modules/providers/services/provider-options-schema-service.ts`,
    ).text();

    expect(source).toContain("confirmed ? { npm: packageName, confirmed: true } : { npm: packageName }");
    expect(source).not.toContain("confirmed: false");
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
        status: { trusted: false, state: "missing", schemaAvailable: true },
      },
    );

    expect(required).toMatchObject({ phase: "install_required", effect: undefined });
    const confirmed = providerOptionsSchemaTransition(required, { type: "install_confirmed" });
    expect(confirmed).toMatchObject({
      phase: "installing",
      effect: { type: "install", confirmed: true },
    });
    expect(providerOptionsSchemaTransition(confirmed, { type: "install_started" }).effect).toBeUndefined();
  });

  test("schema availability is independent of package install state", () => {
    const installedWithSchema = providerOptionsSchemaTransition(
      { ...initialProviderOptionsSchemaState, phase: "checking", committedPackage: "with-schema" },
      {
        type: "status_loaded",
        packageName: "with-schema",
        status: { trusted: false, state: "installed", schemaAvailable: true },
      },
    );
    const installedWithoutSchema = providerOptionsSchemaTransition(
      { ...initialProviderOptionsSchemaState, phase: "checking", committedPackage: "without-schema" },
      {
        type: "status_loaded",
        packageName: "without-schema",
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
        schema: { type: "string" },
        warnings: [],
      }),
    ).toBe(current);
    expect(
      providerOptionsSchemaTransition(current, {
        type: "install_failed",
        packageName: "@ai-sdk/openai",
        errorCode: "install_failed",
      }),
    ).toBe(current);
  });

  test("schema missing is an explicit fallback state", () => {
    expect(
      providerOptionsSchemaTransition(
        { ...initialProviderOptionsSchemaState, phase: "loading_schema", committedPackage: "schema-less" },
        { type: "schema_missing", packageName: "schema-less" },
      ),
    ).toMatchObject({ phase: "schema_unavailable", schema: undefined, warnings: [] });
  });
});
