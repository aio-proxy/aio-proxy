import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

type PackageJson = {
  readonly name: string;
  readonly version: string;
  readonly declarationEntry: string;
};

export type ProviderPackageMetadata = {
  readonly name: string;
  readonly version: string;
};

const stringProperty = (value: unknown, key: string) => {
  if (typeof value !== "object" || value === null) return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : undefined;
};

const readPackageJson = async (packageRoot: string): Promise<PackageJson> => {
  const raw: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const name = stringProperty(raw, "name");
  const version = stringProperty(raw, "version");
  if (!name || !version) throw new Error("Provider package metadata requires name and version");

  const packageObject = typeof raw === "object" && raw !== null ? (raw as { readonly exports?: unknown }) : undefined;
  const exportsValue = packageObject?.exports;
  const rootExport =
    typeof exportsValue === "object" && exportsValue !== null
      ? (exportsValue as Record<string, unknown>)["."]
      : undefined;
  const declarationEntry =
    stringProperty(rootExport, "types") ?? stringProperty(raw, "types") ?? stringProperty(raw, "typings");
  if (!declarationEntry) throw new Error("Provider package has no declaration entry");

  return { name, version, declarationEntry };
};

const isInside = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

export const readProviderPackageMetadata = async (packageRoot: string): Promise<ProviderPackageMetadata> => {
  const { name, version } = await readPackageJson(packageRoot);
  return { name, version };
};

export const resolveDeclarationEntry = async (packageRoot: string) => {
  const root = await realpath(packageRoot);
  const { declarationEntry } = await readPackageJson(root);
  const entry = await realpath(resolve(root, declarationEntry));
  if (!isInside(root, entry)) throw new Error("Declaration entry is outside package root");
  if (!/\.d\.[cm]?ts$/.test(entry)) throw new Error("Declaration entry must be a declaration file");
  return entry;
};
