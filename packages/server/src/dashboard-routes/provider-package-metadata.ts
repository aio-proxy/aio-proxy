import { BUNDLED_PROVIDER_PACKAGES, findInstalledNpmPackage } from "@aio-proxy/core";
import { hasProviderOptionsSchema, providerOptionsSchema } from "@aio-proxy/provider-schemas";
import type { Context } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { isTrustedProviderPackage } from "../provider-package-trust";

const npmPackageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/iu;
const ProviderPackageQuerySchema = z.object({ npm: z.string().regex(npmPackageName) });

export type ProviderPackageStatusResponse = {
  readonly npm: string;
  readonly trusted: boolean;
  readonly state: "bundled" | "installed" | "missing";
  readonly version?: string;
  readonly schemaAvailable: boolean;
};

export type ProviderOptionsSchemaResponse = {
  readonly npm: string;
  readonly packageVersion: string;
  readonly factoryName: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly warnings: readonly { readonly code: string; readonly path: string }[];
};

export const providerPackageQueryValidator = validator("query", (raw, context) => {
  const parsed = ProviderPackageQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const npm = typeof raw["npm"] === "string" ? raw["npm"] : "";
    return context.json({ code: "invalid_package_name", error: `Invalid npm package name: ${npm}` }, 400);
  }
  return parsed.data;
});

export const providerPackageStatus = async (context: Context) => {
  const npm = context.req.query("npm") as string;
  const schema = providerOptionsSchema(npm);
  if (BUNDLED_PROVIDER_PACKAGES.includes(npm as (typeof BUNDLED_PROVIDER_PACKAGES)[number])) {
    return context.json({
      npm,
      trusted: isTrustedProviderPackage(npm),
      state: "bundled",
      ...(schema === undefined ? {} : { version: schema.packageVersion }),
      schemaAvailable: schema !== undefined,
    } satisfies ProviderPackageStatusResponse);
  }

  const installed = await findInstalledNpmPackage(npm);
  return context.json({
    npm,
    trusted: isTrustedProviderPackage(npm),
    state: installed === null ? "missing" : "installed",
    ...(installed === null ? {} : { version: installed.version }),
    schemaAvailable: hasProviderOptionsSchema(npm),
  } satisfies ProviderPackageStatusResponse);
};

export const providerPackageOptionsSchema = (context: Context) => {
  const npm = context.req.query("npm") as string;
  const entry = providerOptionsSchema(npm);
  if (entry === undefined || entry.schema === null) {
    return context.json({ code: "schema_unavailable", error: "provider options schema unavailable" }, 404);
  }
  return context.json({
    npm,
    packageVersion: entry.packageVersion,
    factoryName: entry.factoryName,
    schema: entry.schema,
    warnings: entry.warnings,
  } satisfies ProviderOptionsSchemaResponse);
};
