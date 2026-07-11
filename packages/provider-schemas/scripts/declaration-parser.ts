import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";

const MAX_FILES = 64;
const MAX_DEPTH = 16;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

type AstNode = {
  readonly type: string;
  readonly start?: number | null;
  readonly end?: number | null;
  readonly id?: AstNode | null;
  readonly name?: string;
  readonly value?: string;
  readonly optional?: boolean | null;
  readonly declaration?: AstNode | null;
  readonly declarations?: readonly AstNode[];
  readonly params?: readonly AstNode[];
  readonly parameters?: readonly AstNode[];
  readonly typeAnnotation?: AstNode | null;
  readonly body?: AstNode | readonly AstNode[] | null;
  readonly members?: readonly AstNode[];
  readonly source?: AstNode | null;
  readonly specifiers?: readonly AstNode[];
  readonly local?: AstNode | null;
  readonly key?: AstNode | null;
  readonly imported?: AstNode | null;
  readonly exported?: AstNode | null;
  readonly leadingComments?: readonly { readonly value: string }[] | null;
};

type Declaration = {
  readonly name: string;
  readonly node: AstNode;
  readonly text: string;
};

type Factory = {
  readonly node: AstNode;
  readonly file: FileRecord;
};

type Link = {
  readonly imported: string;
  readonly target: string;
};

type FileRecord = {
  readonly path: string;
  readonly source: string;
  readonly declarations: ReadonlyMap<string, Declaration>;
  readonly imports: ReadonlyMap<string, Link>;
  readonly localFactories: ReadonlyMap<string, AstNode>;
  readonly exportedFactories: ReadonlyMap<string, AstNode>;
  readonly reexports: Map<string, Link>;
  readonly exportAll: string[];
};

export type ParsedProviderFactoryDeclaration = {
  readonly parameterType: string;
  readonly optional: boolean;
  readonly declarations: readonly string[];
  readonly documentation: Readonly<Record<string, string>>;
};

export type ParseProviderFactoryDeclarationOptions = {
  readonly packageRoot: string;
  readonly declarationEntry: string;
  readonly factoryName: string;
};

const nodeName = (node: AstNode | null | undefined) =>
  node?.type === "Identifier" || node?.type === "StringLiteral" ? (node.name ?? node.value) : undefined;

const nodeText = (source: string, node: AstNode) => {
  if (node.start == null || node.end == null) throw new Error("Declaration is missing source offsets");
  return source.slice(node.start, node.end);
};

const isInside = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const resolveRelativeDeclaration = async (root: string, from: string, specifier: string) => {
  const base = resolve(from, "..", specifier);
  const candidates = /\.d\.[cm]?ts$/.test(base)
    ? [base]
    : [base, `${base}.d.ts`, `${base}.d.mts`, `${base}.d.cts`, resolve(base, "index.d.ts")];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const target = await realpath(candidate);
      if (!isInside(root, target)) throw new Error("Relative declaration is outside package root");
      return target;
    } catch (error) {
      if (error instanceof Error && error.message.includes("outside package root")) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Cannot resolve ${specifier}`);
};

const factoryFromVariable = (declaration: AstNode) => {
  for (const variable of declaration.declarations ?? []) {
    const name = nodeName(variable.id);
    const annotation = variable.id?.typeAnnotation?.typeAnnotation;
    if (name && annotation?.type === "TSFunctionType") return { name, node: annotation };
  }
  return undefined;
};

const factoryFromDeclaration = (declaration: AstNode | null | undefined) => {
  if (!declaration) return undefined;
  if (declaration.type === "TSDeclareFunction" || declaration.type === "FunctionDeclaration") {
    const name = nodeName(declaration.id);
    return name ? { name, node: declaration } : undefined;
  }
  if (declaration.type === "VariableDeclaration") return factoryFromVariable(declaration);
  return undefined;
};

const sourceSpecifier = (node: AstNode | null | undefined) =>
  node?.type === "StringLiteral" && typeof node.value === "string" ? node.value : undefined;

const parseFile = async (
  root: string,
  path: string,
  depth: number,
  state: { files: Map<string, FileRecord>; bytes: number },
): Promise<FileRecord> => {
  if (depth > MAX_DEPTH) throw new Error("Declaration traversal depth limit exceeded");
  const existing = state.files.get(path);
  if (existing) return existing;
  if (state.files.size >= MAX_FILES) throw new Error("Declaration traversal file limit exceeded");

  const source = await readFile(path, "utf8");
  state.bytes += Buffer.byteLength(source);
  if (state.bytes > MAX_SOURCE_BYTES) throw new Error("Declaration traversal source limit exceeded");

  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const declarations = new Map<string, Declaration>();
  const imports = new Map<string, Link>();
  const localFactories = new Map<string, AstNode>();
  const exportedFactories = new Map<string, AstNode>();
  const pendingImports: { local: string; imported: string; specifier: string }[] = [];
  const pendingReexports: { exported: string; imported: string; specifier: string }[] = [];
  const pendingExportAll: string[] = [];

  for (const statement of ast.program.body as readonly AstNode[]) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "TSInterfaceDeclaration" || declaration?.type === "TSTypeAliasDeclaration") {
      const name = nodeName(declaration.id);
      if (name) declarations.set(name, { name, node: declaration, text: nodeText(source, declaration) });
    }

    const localFactory = factoryFromDeclaration(declaration);
    if (localFactory) {
      localFactories.set(localFactory.name, localFactory.node);
      if (statement.type === "ExportNamedDeclaration") {
        exportedFactories.set(localFactory.name, localFactory.node);
      }
    }

    if (statement.type === "ImportDeclaration") {
      const specifier = sourceSpecifier(statement.source);
      if (!specifier?.startsWith(".")) continue;
      for (const importSpecifier of statement.specifiers ?? []) {
        const local = nodeName(importSpecifier.local);
        const imported =
          importSpecifier.type === "ImportDefaultSpecifier" ? "default" : nodeName(importSpecifier.imported);
        if (local && imported) pendingImports.push({ local, imported, specifier });
      }
    }

    if (statement.type === "ExportNamedDeclaration") {
      const specifier = sourceSpecifier(statement.source);
      for (const exportSpecifier of statement.specifiers ?? []) {
        const exported = nodeName(exportSpecifier.exported);
        const imported = nodeName(exportSpecifier.local);
        if (!exported || !imported) continue;
        if (specifier?.startsWith(".")) {
          pendingReexports.push({ exported, imported, specifier });
        } else {
          const factory = localFactories.get(imported);
          if (factory) exportedFactories.set(exported, factory);
        }
      }
    }

    if (statement.type === "ExportAllDeclaration") {
      const specifier = sourceSpecifier(statement.source);
      if (specifier?.startsWith(".")) pendingExportAll.push(specifier);
    }
  }

  const record: FileRecord = {
    path,
    source,
    declarations,
    imports,
    localFactories,
    exportedFactories,
    reexports: new Map(),
    exportAll: [],
  };
  state.files.set(path, record);

  const targets = new Map<string, string>();
  const targetFor = async (specifier: string) => {
    const cached = targets.get(specifier);
    if (cached) return cached;
    const target = await resolveRelativeDeclaration(root, path, specifier);
    targets.set(specifier, target);
    await parseFile(root, target, depth + 1, state);
    return target;
  };

  for (const item of pendingImports) {
    imports.set(item.local, { imported: item.imported, target: await targetFor(item.specifier) });
  }
  for (const item of pendingReexports) {
    record.reexports.set(item.exported, {
      imported: item.imported,
      target: await targetFor(item.specifier),
    });
  }
  for (const specifier of pendingExportAll) {
    record.exportAll.push(await targetFor(specifier));
  }

  for (const statement of ast.program.body as readonly AstNode[]) {
    if (statement.type !== "ExportNamedDeclaration" || statement.source) continue;
    for (const specifier of statement.specifiers ?? []) {
      const exported = nodeName(specifier.exported);
      const local = nodeName(specifier.local);
      const factory = local ? localFactories.get(local) : undefined;
      if (exported && factory) exportedFactories.set(exported, factory);
      const imported = local ? imports.get(local) : undefined;
      if (exported && imported) record.reexports.set(exported, imported);
    }
  }

  return record;
};

const resolveFactory = (
  files: ReadonlyMap<string, FileRecord>,
  file: FileRecord,
  name: string,
  seen = new Set<string>(),
): Factory | undefined => {
  const key = `${file.path}:${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const local = file.exportedFactories.get(name);
  if (local) return { node: local, file };
  const reexport = file.reexports.get(name);
  if (reexport) {
    const target = files.get(reexport.target);
    if (target) return resolveFactory(files, target, reexport.imported, seen);
  }
  for (const targetPath of file.exportAll) {
    const target = files.get(targetPath);
    const factory = target ? resolveFactory(files, target, name, seen) : undefined;
    if (factory) return factory;
  }
  return undefined;
};

const functionParameter = (node: AstNode) => (node.params ?? node.parameters ?? [])[0];

const unwrapTypeAnnotation = (node: AstNode | null | undefined) =>
  node?.type === "TSTypeAnnotation" ? node.typeAnnotation : node;

const identifiers = (source: string) => source.match(/[A-Za-z_$][\w$]*/g) ?? [];

const normalizeJsDoc = (value: string) =>
  value
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd())
    .filter(Boolean)
    .join("\n")
    .trim();

const isNodeArray = (value: AstNode | readonly AstNode[] | null | undefined): value is readonly AstNode[] =>
  Array.isArray(value);

const propertyDocumentation = (declaration: Declaration) => {
  const documentation: Record<string, string> = {};
  const body = declaration.node.body;
  const members = isNodeArray(body) ? body : body?.body;
  if (!members || !isNodeArray(members)) return documentation;
  for (const member of members) {
    if (member.type !== "TSPropertySignature") continue;
    const property = nodeName(member.key as AstNode | undefined);
    const comment = member.leadingComments?.at(-1);
    if (property && comment) {
      const text = normalizeJsDoc(comment.value);
      if (text) documentation[`${declaration.name}.${property}`] = text;
    }
  }
  return documentation;
};

const resolveDeclaration = (
  files: ReadonlyMap<string, FileRecord>,
  file: FileRecord,
  name: string,
  seenSymbols: Set<string>,
  collected: Map<string, Declaration>,
) => {
  const key = `${file.path}:${name}`;
  if (seenSymbols.has(key)) return;
  seenSymbols.add(key);

  const declaration = file.declarations.get(name);
  if (declaration) {
    collected.set(key, declaration);
    for (const reference of identifiers(declaration.text)) {
      if (reference !== name) resolveDeclaration(files, file, reference, seenSymbols, collected);
    }
    return;
  }

  const imported = file.imports.get(name) ?? file.reexports.get(name);
  if (imported) {
    const target = files.get(imported.target);
    if (target) resolveDeclaration(files, target, imported.imported, seenSymbols, collected);
    return;
  }
  for (const targetPath of file.exportAll) {
    const target = files.get(targetPath);
    if (target) resolveDeclaration(files, target, name, seenSymbols, collected);
  }
};

export const parseProviderFactoryDeclaration = async (
  options: ParseProviderFactoryDeclarationOptions,
): Promise<ParsedProviderFactoryDeclaration> => {
  const packageRoot = await realpath(options.packageRoot);
  const declarationEntry = await realpath(options.declarationEntry);
  if (!isInside(packageRoot, declarationEntry)) {
    throw new Error("Declaration entry is outside package root");
  }

  const state = { files: new Map<string, FileRecord>(), bytes: 0 };
  const entry = await parseFile(packageRoot, declarationEntry, 0, state);
  const factory = resolveFactory(state.files, entry, options.factoryName);
  if (!factory) throw new Error(`Exported provider factory not found: ${options.factoryName}`);

  const parameter = functionParameter(factory.node);
  const parameterTypeNode = unwrapTypeAnnotation(parameter?.typeAnnotation);
  if (!parameter || !parameterTypeNode) {
    throw new Error(`Provider factory has no typed parameter: ${options.factoryName}`);
  }
  const parameterType = nodeText(factory.file.source, parameterTypeNode);
  const declarations = new Map<string, Declaration>();
  for (const reference of identifiers(parameterType)) {
    resolveDeclaration(state.files, factory.file, reference, new Set(), declarations);
  }

  const documentation: Record<string, string> = {};
  for (const declaration of declarations.values()) {
    Object.assign(documentation, propertyDocumentation(declaration));
  }

  return {
    parameterType,
    optional: parameter.optional === true || parameter.type === "AssignmentPattern",
    declarations: [...declarations.values()].map((declaration) => declaration.text),
    documentation,
  };
};
