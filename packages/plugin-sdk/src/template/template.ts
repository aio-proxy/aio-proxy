import { type AST, parse } from '@handlebars/parser';

const VARIABLE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;

/** Interpolates simple Handlebars variables without HTML escaping. The resolver
 * owns the variable allowlist; helpers, blocks and property traversal are never executed. */
export function renderTemplate(source: string, resolve: (name: string) => string): string {
  let program: AST.Program;
  try {
    program = parse(source);
  } catch {
    throw invalidTemplate();
  }
  return program.body
    .map((statement) => {
      if (statement.type === 'ContentStatement') return (statement as AST.ContentStatement).value;
      if (statement.type !== 'MustacheStatement') throw invalidTemplate();
      const mustache = statement as AST.MustacheStatement;
      if (
        !mustache.escaped ||
        mustache.params.length > 0 ||
        (mustache.hash?.pairs.length ?? 0) > 0 ||
        mustache.strip?.open ||
        mustache.strip?.close
      ) {
        throw invalidTemplate();
      }
      if (mustache.path.type !== 'PathExpression') throw invalidTemplate();
      const path = mustache.path as AST.PathExpression & { readonly this?: boolean };
      if (path.data || path.depth !== 0 || path.this === true) throw invalidTemplate();
      const loc = path.loc;
      if (loc === undefined || loc.start.line !== loc.end.line) throw invalidTemplate();
      // Handlebars counts bare CR, CRLF and LF as line breaks.
      const name = source.split(/\r\n|\r|\n/u)[loc.start.line - 1]?.slice(loc.start.column, loc.end.column);
      if (name === undefined || !VARIABLE_PATH.test(name) || name.startsWith('this.')) throw invalidTemplate();
      return resolve(name);
    })
    .join('');
}

function invalidTemplate(): TypeError {
  return new TypeError('Unsupported template');
}
