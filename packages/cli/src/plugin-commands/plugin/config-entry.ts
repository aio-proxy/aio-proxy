import { BUILT_IN_PLUGIN_PACKAGE_NAMES, isNpmPackageName, type PluginSecretSnapshot } from "@aio-proxy/core";
import { PluginPackageNameSchema } from "@aio-proxy/types";
import { isPlainObject } from "es-toolkit/predicate";

export type ConfigRecord = Record<string, unknown>;

export function entries(config: ConfigRecord): unknown[] {
  return Array.isArray(config.plugins) ? config.plugins : [];
}

export function packageNameOf(entry: unknown): string | null {
  const candidate = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : undefined;
  const parsed = PluginPackageNameSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function requirePluginPackageName(value: string): string {
  return PluginPackageNameSchema.parse(value);
}

export function publicOptionsOf(entry: unknown): Record<string, unknown> {
  return Array.isArray(entry) && isPlainObject(entry[1]) ? entry[1] : {};
}

export function pluginEntry(packageName: string, publicValues: Record<string, unknown>): unknown {
  return Object.keys(publicValues).length === 0 ? packageName : [packageName, publicValues];
}

export function replacePlugin(config: ConfigRecord, packageName: string, entry: unknown): ConfigRecord {
  const current = entries(config);
  const found = current.findIndex((candidate) => packageNameOf(candidate) === packageName);
  return {
    ...config,
    plugins: found < 0 ? [...current, entry] : current.map((candidate, index) => (index === found ? entry : candidate)),
  };
}

export function removePlugin(config: ConfigRecord, packageName: string): ConfigRecord {
  return { ...config, plugins: entries(config).filter((entry) => packageNameOf(entry) !== packageName) };
}

export function secretRecord(snapshot: PluginSecretSnapshot | null): Record<string, unknown> {
  return isPlainObject(snapshot?.value) ? snapshot.value : {};
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function usedPackageNames(config: ConfigRecord): Set<string> {
  const builtIns = new Set<string>(BUILT_IN_PLUGIN_PACKAGE_NAMES);
  const used = new Set(
    entries(config)
      .map(packageNameOf)
      .filter((name): name is string => name !== null && !builtIns.has(name)),
  );
  if (isRecord(config.providers)) {
    for (const provider of Object.values(config.providers)) {
      if (!isRecord(provider) || provider.kind !== "ai-sdk") continue;
      const packageName = typeof provider.packageName === "string" ? provider.packageName : provider.package;
      if (isNpmPackageName(packageName)) used.add(packageName);
    }
  }
  return used;
}
