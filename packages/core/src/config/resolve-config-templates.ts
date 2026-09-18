import { type AST, parse } from '@handlebars/parser';
import { mapValues } from 'es-toolkit/object';
import { isPlainObject } from 'es-toolkit/predicate';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const EXACT_ENV_PATH = /^env\.[A-Za-z_][A-Za-z0-9_]*$/u;
const UNSUPPORTED_TEMPLATE = 'Unsupported config template';

export function resolveConfigTemplates(
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
  onReference?: (name: string) => void,
): unknown {
  if (typeof value === 'string') return resolveString(value, env, onReference);
  if (Array.isArray(value)) return value.map((item) => resolveConfigTemplates(item, env, onReference));
  if (!isPlainObject(value)) return value;
  return mapValues(value, (child) => resolveConfigTemplates(child, env, onReference));
}

/**
 * The `{{env.NAME}}` references a value would resolve against nothing. Resolution substitutes an
 * empty string for an absent variable, which silently turns a synchronized `apiKey` into an
 * unauthenticated one, so callers that must not apply a half-resolved configuration ask first.
 */
export function collectMissingTemplateEnv(
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const missing = new Set<string>();
  resolveConfigTemplates(value, env, (name) => {
    if (typeof env[name] !== 'string') missing.add(name);
  });
  return [...missing];
}

function resolveString(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  onReference?: (name: string) => void,
): string {
  let program: AST.Program;
  try {
    program = parse(value);
  } catch {
    throw new TypeError(UNSUPPORTED_TEMPLATE);
  }
  return program.body.map((statement) => evaluateStatement(statement, value, env, onReference)).join('');
}

function evaluateStatement(
  statement: AST.Statement,
  source: string,
  env: Readonly<Record<string, string | undefined>>,
  onReference?: (name: string) => void,
): string {
  if (statement.type === 'ContentStatement') return (statement as AST.ContentStatement).value;
  if (statement.type !== 'MustacheStatement') throw invalidTemplate();
  const mustache = statement as AST.MustacheStatement;
  if (!mustache.escaped || mustache.params.length > 0 || (mustache.hash?.pairs.length ?? 0) > 0) {
    throw invalidTemplate();
  }
  if (mustache.strip?.open || mustache.strip?.close) throw invalidTemplate();
  if (mustache.path.type !== 'PathExpression') throw invalidTemplate();
  const path = mustache.path as AST.PathExpression & { readonly this?: boolean };
  if (path.data || path.depth !== 0 || path.this === true || path.parts.length !== 2 || path.parts[0] !== 'env') {
    throw invalidTemplate();
  }
  const name = path.parts[1];
  if (typeof name !== 'string' || !ENV_NAME.test(name)) throw invalidTemplate();
  const pathSource = sliceLoc(source, path.loc);
  if (pathSource === undefined || !EXACT_ENV_PATH.test(pathSource)) throw invalidTemplate();
  onReference?.(name);
  if (!Object.hasOwn(env, name)) return '';
  const resolved = env[name];
  return typeof resolved === 'string' ? resolved : '';
}

function sliceLoc(source: string, loc: AST.SourceLocation | undefined): string | undefined {
  if (loc === undefined || loc.start.line !== loc.end.line) return undefined;
  // Handlebars treats bare CR as a line break; match CRLF, CR, and LF when locating the path.
  const line = source.split(/\r\n|\r|\n/u)[loc.start.line - 1];
  if (line === undefined) return undefined;
  return line.slice(loc.start.column, loc.end.column);
}

function invalidTemplate(): TypeError {
  return new TypeError(UNSUPPORTED_TEMPLATE);
}
