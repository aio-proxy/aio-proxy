import type { RsbuildPlugin } from "@aio-proxy/infra/rslib";

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const LOBE_ICON_KEY_HELPER = "AioProxyLobeIconKey";
const LOBE_ICON_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type LobeIconPackage = {
  readonly iconsDirectory: string;
  readonly version: string;
};

export function resolveLobeIconPackage(fromUrl: string): LobeIconPackage {
  const packageJsonPath = createRequire(fromUrl).resolve("@lobehub/icons-static-svg/package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { readonly version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
    throw new Error("@lobehub/icons-static-svg has no valid version");
  }
  return {
    iconsDirectory: join(dirname(packageJsonPath), "icons"),
    version: packageJson.version,
  };
}

export function iconKeysFromFileNames(fileNames: readonly string[]): readonly string[] {
  const svgFiles = fileNames.filter((name) => name.endsWith(".svg"));
  if (svgFiles.length === 0) throw new Error("@lobehub/icons-static-svg contains no SVG icons");
  const seen = new Set<string>();
  const keys = svgFiles.map((name) => {
    const key = name.slice(0, -4);
    if (!LOBE_ICON_SLUG.test(key)) throw new Error(`Invalid Lobe icon filename: ${name}`);
    if (seen.has(key)) throw new Error(`Duplicate Lobe icon key: ${key}`);
    seen.add(key);
    return key;
  });
  return keys.toSorted();
}

export function readLobeIconKeys(iconsDirectory: string): readonly string[] {
  const files = readdirSync(iconsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  return iconKeysFromFileNames(files);
}

export function renderLobeIconKeyDeclaration(keys: readonly string[]): string {
  return `export type LobeIconKey = ${keys.map((key) => JSON.stringify(key)).join(" | ")};\n`;
}

export function lobeIconTypePath(cachePath: string, version: string): string {
  return join(cachePath, "aio-proxy", "plugin-sdk", "lobe-icons", version, "index.d.ts");
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

export function prepareLobeIconTypeBuild(options: {
  readonly cachePath: string;
  readonly iconsDirectory: string;
  readonly version: string;
}): { readonly declaration: string; readonly declarationPath: string } {
  const declarationPath = lobeIconTypePath(options.cachePath, options.version);
  const declaration = `declare type ${LOBE_ICON_KEY_HELPER} = ${readLobeIconKeys(options.iconsDirectory)
    .map((key) => JSON.stringify(key))
    .join(" | ")};\n`;
  writeAtomic(declarationPath, declaration);
  return { declaration, declarationPath };
}

export function createLobeIconTypePlugin(options: {
  readonly declarationPath: string;
  readonly version: string;
}): RsbuildPlugin {
  return {
    name: "aio-proxy-lobe-icon-key-type",
    apply: "build",
    setup(api) {
      const declarationPath = lobeIconTypePath(api.context.cachePath, options.version);
      if (declarationPath !== options.declarationPath) {
        throw new Error("Lobe icon declaration cache path does not match Rslib configuration");
      }
    },
  };
}
