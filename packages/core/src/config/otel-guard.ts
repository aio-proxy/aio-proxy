import { validateHeaderValue } from 'node:http';

import { type AST, parse } from '@handlebars/parser';
import { isPlainObject } from 'es-toolkit/predicate';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const EXACT_ENV_PATH = /^env\.[A-Za-z_][A-Za-z0-9_]*$/u;
const UNSUPPORTED_TEMPLATE = 'Unsupported config template';
const OTLP_HEADERS_ENV = 'OTEL_EXPORTER_OTLP_HEADERS';
const OTLP_TRACES_HEADERS_ENV = 'OTEL_EXPORTER_OTLP_TRACES_HEADERS';

export function assertOtelConfig(value: unknown, env: Readonly<Record<string, string | undefined>>): void {
  if (!isPlainObject(value)) return;
  const server = value['server'];
  if (!isPlainObject(server)) return;
  const otel = server['otel'];
  if (!isPlainObject(otel)) return;
  const destinations = otel['destinations'];
  if (!Array.isArray(destinations)) return;

  if (destinations.length > 0) {
    assertNoOtlpHeaderEnvConflict(env);
  }

  for (const destination of destinations) {
    if (!isPlainObject(destination)) continue;
    const url = destination['url'];
    if (typeof url === 'string') {
      validateTemplateEnvRefs(url, env);
    }
    const headers = destination['headers'];
    if (!isPlainObject(headers)) continue;
    for (const headerValue of Object.values(headers)) {
      if (typeof headerValue === 'string') {
        validateTemplateEnvRefs(headerValue, env);
      }
    }
  }
}

export function assertExpandedOtelHeaders(value: unknown): void {
  if (!isPlainObject(value)) return;
  const server = value['server'];
  if (!isPlainObject(server)) return;
  const otel = server['otel'];
  if (!isPlainObject(otel)) return;
  const destinations = otel['destinations'];
  if (!Array.isArray(destinations)) return;

  for (const destination of destinations) {
    if (!isPlainObject(destination)) continue;
    const headers = destination['headers'];
    if (!isPlainObject(headers)) continue;
    for (const [name, headerValue] of Object.entries(headers)) {
      if (typeof headerValue !== 'string') continue;
      try {
        validateHeaderValue(name, headerValue);
      } catch {
        throw new TypeError(`Invalid server.otel header ${name}`);
      }
    }
  }
}

function assertNoOtlpHeaderEnvConflict(env: Readonly<Record<string, string | undefined>>): void {
  const otlpHeaders = env[OTLP_HEADERS_ENV];
  if (typeof otlpHeaders === 'string' && otlpHeaders.length > 0) {
    throw new TypeError(`${OTLP_HEADERS_ENV} cannot be combined with server.otel destinations`);
  }
  const tracesHeaders = env[OTLP_TRACES_HEADERS_ENV];
  if (typeof tracesHeaders === 'string' && tracesHeaders.length > 0) {
    throw new TypeError(`${OTLP_TRACES_HEADERS_ENV} cannot be combined with server.otel destinations`);
  }
}

function validateTemplateEnvRefs(template: string, env: Readonly<Record<string, string | undefined>>): void {
  let program: AST.Program;
  try {
    program = parse(template);
  } catch {
    throw new TypeError(UNSUPPORTED_TEMPLATE);
  }
  for (const statement of program.body) {
    const name = extractEnvName(statement, template);
    if (name === undefined) continue;
    if (!Object.hasOwn(env, name) || typeof env[name] !== 'string' || env[name].length === 0) {
      throw new TypeError(`Missing or empty environment variable ${name} referenced by server.otel`);
    }
  }
}

function extractEnvName(statement: AST.Statement, source: string): string | undefined {
  if (statement.type === 'ContentStatement') return undefined;
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
  return name;
}

function sliceLoc(source: string, loc: AST.SourceLocation | undefined): string | undefined {
  if (loc === undefined || loc.start.line !== loc.end.line) return undefined;
  const line = source.split(/\r\n|\r|\n/u)[loc.start.line - 1];
  if (line === undefined) return undefined;
  return line.slice(loc.start.column, loc.end.column);
}

function invalidTemplate(): TypeError {
  return new TypeError(UNSUPPORTED_TEMPLATE);
}
