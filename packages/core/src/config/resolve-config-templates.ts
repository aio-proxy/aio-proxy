import { type AST, parse } from "@handlebars/parser";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function resolveConfigTemplates(
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): unknown {
  if (typeof value === "string") return resolveString(value, env);
  if (Array.isArray(value)) return value.map((item) => resolveConfigTemplates(item, env));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveConfigTemplates(child, env)]));
}

function resolveString(value: string, env: Readonly<Record<string, string | undefined>>): string {
  const program = parse(value);
  return program.body.map((statement) => evaluateStatement(statement, env)).join("");
}

function evaluateStatement(statement: AST.Statement, env: Readonly<Record<string, string | undefined>>): string {
  if (statement.type === "ContentStatement") return (statement as AST.ContentStatement).value;
  if (statement.type !== "MustacheStatement") throw invalidTemplate(statement);
  const mustache = statement as AST.MustacheStatement;
  if (!mustache.escaped || mustache.params.length > 0 || (mustache.hash?.pairs.length ?? 0) > 0) {
    throw invalidTemplate(statement);
  }
  if (mustache.path.type !== "PathExpression") throw invalidTemplate(statement);
  const path = mustache.path as AST.PathExpression;
  if (path.data || path.depth !== 0 || path.parts.length !== 2 || path.parts[0] !== "env")
    throw invalidTemplate(statement);
  const name = path.parts[1];
  if (typeof name !== "string" || !ENV_NAME.test(name)) throw invalidTemplate(statement);
  return env[name] ?? "";
}

function invalidTemplate(node: AST.Node): TypeError {
  return new TypeError(`Unsupported config template at ${node.loc.start.line}:${node.loc.start.column}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
