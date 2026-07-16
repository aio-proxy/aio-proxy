import { BUNDLED_PROVIDER_PACKAGES, BUNDLED_PROVIDER_VERSIONS, findInstalledNpmPackage } from "@aio-proxy/core";
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
};

export const providerPackageQueryValidator = validator("query", (raw, context) => {
  const parsed = ProviderPackageQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const rawNpm: unknown = Reflect.get(raw, "npm");
    const npm = typeof rawNpm === "string" ? rawNpm : "";
    return context.json({ code: "invalid_package_name", error: `Invalid npm package name: ${npm}` }, 400);
  }
  return parsed.data;
});

export const providerPackageStatus = async (npm: string): Promise<ProviderPackageStatusResponse> => {
  if (BUNDLED_PROVIDER_PACKAGES.includes(npm as (typeof BUNDLED_PROVIDER_PACKAGES)[number])) {
    return {
      npm,
      trusted: isTrustedProviderPackage(npm),
      state: "bundled",
      version: BUNDLED_PROVIDER_VERSIONS[npm as (typeof BUNDLED_PROVIDER_PACKAGES)[number]],
    };
  }

  const installed = await findInstalledNpmPackage(npm);
  return {
    npm,
    trusted: isTrustedProviderPackage(npm),
    state: installed === null ? "missing" : "installed",
    ...(installed === null ? {} : { version: installed.version }),
  };
};
