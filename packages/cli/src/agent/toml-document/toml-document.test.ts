import { expect, test } from 'bun:test';

import { editTomlFields, inspectTomlPaths, readTomlField } from './index';

test.each([
  {
    source: '# keep\n[auth]\nauth_provider_label = \'Cloud\' # tail\n[ui]\ntheme="dark"\n',
    path: ['auth', 'auth_provider_label'],
    value: 'AIO Proxy',
    preserved: '[ui]\ntheme="dark"\n',
    tomlVersion: '1.0' as const,
  },
  {
    source: '# keep\n[model_providers."proxy.team"]\nname = \'Cloud\' # tail\n[mcp_servers.local]\ncommand="mcp"\n',
    path: ['model_providers', 'proxy.team', 'name'],
    value: 'aio-proxy',
    preserved: '[mcp_servers.local]\ncommand="mcp"\n',
    tomlVersion: '1.1' as const,
  },
])('edits $path while preserving surrounding bytes', ({ source, path, value, preserved, tomlVersion }) => {
  const syntax = { tomlVersion };
  const original = readTomlField(source, path, syntax);
  const changed = editTomlFields(source, [{ path, next: { present: true, value } }], syntax);
  expect(changed.text).toContain('# keep\n');
  expect(changed.text).toContain('# tail\n');
  expect(changed.text).toContain(preserved);
  expect(readTomlField(changed.text, path, syntax)).toMatchObject({ present: true, value });
  const restored = editTomlFields(changed.text, [{ path, next: original }], syntax);
  expect(restored.text).toBe(source);
});

test('inserts multiple leaves into one inline table without losing unrelated members', () => {
  const source = 'endpoints = { other = "keep,comma" } # tail\n';
  const result = editTomlFields(
    source,
    [
      { path: ['endpoints', 'models_base_url'], next: { present: true, value: 'http://127.0.0.1:9317/v1' } },
      {
        path: ['endpoints', 'models_list_url'],
        next: { present: true, value: 'http://127.0.0.1:9317/v1/models' },
      },
    ],
    { tomlVersion: '1.0' },
  );
  expect(result.text).toContain('other = "keep,comma"');
  expect(result.text).toContain('# tail\n');
  expect(Bun.TOML.parse(result.text).endpoints.models_list_url.endsWith('/v1/models')).toBe(true);
});

test('prunes only caller-owned empty tables', () => {
  const source = '[auth]\nlabel="managed"\n\n[user_empty]\n';
  const result = editTomlFields(source, [{ path: ['auth', 'label'], next: { present: false } }], {
    tomlVersion: '1.0',
    removeEmptyTables: [['auth']],
  });
  expect(result.text).not.toContain('[auth]');
  expect(result.text).toContain('[user_empty]');
});

test('does not prune a listed table that still has user fields', () => {
  const source = '[auth]\nlabel = "managed"\ncustom = "keep"\n';
  const result = editTomlFields(source, [{ path: ['auth', 'label'], next: { present: false } }], {
    tomlVersion: '1.0',
    removeEmptyTables: [['auth']],
  });
  expect(result.text).toContain('[auth]');
  expect(result.text).toContain('custom = "keep"');
  expect(result.text).not.toContain('label =');
});

test('keeps a quoted dotted table identity and does not split it', () => {
  const syntax = { tomlVersion: '1.0' as const };
  const source = '["dotted.key"]\nlabel = "old"\n';
  const result = editTomlFields(
    source,
    [{ path: ['dotted.key', 'label'], next: { present: true, value: 'new' } }],
    syntax,
  );
  expect(result.text).toContain('["dotted.key"]');
  expect(readTomlField(result.text, ['dotted.key', 'label'], syntax)).toMatchObject({ present: true, value: 'new' });
  expect(inspectTomlPaths(result.text, syntax).tablePaths).toContainEqual(['dotted.key']);
  expect(inspectTomlPaths(result.text, syntax).fieldPaths).toContainEqual(['dotted.key', 'label']);
});

test('inserts into a CRLF document without converting line endings', () => {
  const source = '[auth]\r\nlabel = "old"\r\n';
  const result = editTomlFields(source, [{ path: ['auth', 'extra'], next: { present: true, value: true } }], {
    tomlVersion: '1.0',
  });
  expect(result.text).toContain('[auth]\r\nlabel = "old"\r\n');
  expect(result.text.includes('\n') && !result.text.includes('\r\n')).toBe(false);
  expect(Bun.TOML.parse(result.text).auth.extra).toBe(true);
});

test('inserts into a nested inline table while keeping siblings', () => {
  const source = 'root = { inner = { keep = "yes" }, other = "out" } # tail\n';
  const result = editTomlFields(source, [{ path: ['root', 'inner', 'added'], next: { present: true, value: true } }], {
    tomlVersion: '1.0',
  });
  expect(result.text).toContain('# tail\n');
  expect(Bun.TOML.parse(result.text).root).toEqual({ inner: { keep: 'yes', added: true }, other: 'out' });
});

test('inserts two new subtables into one inline parent in a single edit', () => {
  const source = 'root = { keep = "yes" }\n';
  const result = editTomlFields(
    source,
    [
      { path: ['root', 'a', 'x'], next: { present: true, value: '1' } },
      { path: ['root', 'b', 'y'], next: { present: true, value: '2' } },
    ],
    { tomlVersion: '1.0' },
  );
  expect(result.text).toContain('keep = "yes"');
  expect(result.createdTables).toEqual([]);
  expect(Bun.TOML.parse(result.text).root).toEqual({ keep: 'yes', a: { x: '1' }, b: { y: '2' } });
});

test('deletes the first two, last two, and all inline members in one patch each', () => {
  const source = 'items = { a = "1", b = "2", c = "3", d = "4" }\n';
  const syntax = { tomlVersion: '1.0' as const };
  const firstTwo = editTomlFields(
    source,
    [
      { path: ['items', 'a'], next: { present: false } },
      { path: ['items', 'b'], next: { present: false } },
    ],
    syntax,
  );
  expect(Bun.TOML.parse(firstTwo.text).items).toEqual({ c: '3', d: '4' });
  expect(firstTwo.text.startsWith('items = {')).toBe(true);

  const lastTwo = editTomlFields(
    source,
    [
      { path: ['items', 'c'], next: { present: false } },
      { path: ['items', 'd'], next: { present: false } },
    ],
    syntax,
  );
  expect(Bun.TOML.parse(lastTwo.text).items).toEqual({ a: '1', b: '2' });

  const all = editTomlFields(
    source,
    [
      { path: ['items', 'a'], next: { present: false } },
      { path: ['items', 'b'], next: { present: false } },
      { path: ['items', 'c'], next: { present: false } },
      { path: ['items', 'd'], next: { present: false } },
    ],
    syntax,
  );
  expect(Bun.TOML.parse(all.text).items).toEqual({});
  expect(all.text).toContain('items = {');
});

test('restores the original scalar literal from raw and rejects injected statements', () => {
  const syntax = { tomlVersion: '1.0' as const };
  const source = "label = 'Cloud' # tail\n";
  const original = readTomlField(source, ['label'], syntax);
  expect(original).toMatchObject({ present: true, value: 'Cloud', raw: "'Cloud'" });
  const changed = editTomlFields(source, [{ path: ['label'], next: { present: true, value: 'AIO Proxy' } }], syntax);
  expect(changed.text).toContain('label = "AIO Proxy" # tail\n');
  const restored = editTomlFields(changed.text, [{ path: ['label'], next: original }], syntax);
  expect(restored.text).toBe(source);

  expect(() =>
    editTomlFields(
      changed.text,
      [{ path: ['label'], next: { present: true, value: 'Cloud', raw: "'Cloud'\ninjected = 1" } }],
      syntax,
    ),
  ).toThrow(/invalid toml value literal/i);
  expect(() =>
    editTomlFields(
      changed.text,
      [{ path: ['label'], next: { present: true, value: 'Cloud', raw: "'Cloud' # injected" } }],
      syntax,
    ),
  ).toThrow(/invalid toml value literal/i);
});

test('does not rewrite an unchanged literal when raw is omitted', () => {
  const source = "label = 'Cloud'\n";
  const result = editTomlFields(source, [{ path: ['label'], next: { present: true, value: 'Cloud' } }], {
    tomlVersion: '1.0',
  });
  expect(result.text).toBe(source);
});

test('rejects duplicate keys and does not leak document text', () => {
  const source = 'secret = "should-not-leak"\nsecret = "again"\n';
  expect(() => inspectTomlPaths(source, { tomlVersion: '1.0' })).toThrow('Invalid TOML document');
  try {
    inspectTomlPaths(source, { tomlVersion: '1.0' });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('should-not-leak');
  }
});

test('rejects edits under arrays and array tables', () => {
  expect(() =>
    editTomlFields('products = ["keep"]\n', [{ path: ['products', 'name'], next: { present: true, value: 'x' } }], {
      tomlVersion: '1.0',
    }),
  ).toThrow(/array/i);
  expect(() =>
    editTomlFields('[[products]]\nname = "n"\n', [{ path: ['products', 'sku'], next: { present: true, value: 'x' } }], {
      tomlVersion: '1.0',
    }),
  ).toThrow(/array/i);
});

test('reports non-scalar managed reads and leaves other values untouched', () => {
  const source = 'count = 1\n[auth]\nlabel = "a"\n';
  expect(() => readTomlField(source, ['count'], { tomlVersion: '1.0' })).toThrow(/string or boolean/i);
  const result = editTomlFields(source, [{ path: ['auth', 'label'], next: { present: true, value: 'b' } }], {
    tomlVersion: '1.0',
  });
  expect(result.text).toContain('count = 1\n');
  expect(Bun.TOML.parse(result.text).count).toBe(1);
});

test('records created standard table headers and not inline containers', () => {
  const created = editTomlFields(
    'theme = "dark"\n',
    [{ path: ['auth', 'label'], next: { present: true, value: 'AIO Proxy' } }],
    { tomlVersion: '1.0' },
  );
  expect(created.createdTables).toEqual([['auth']]);
  expect(created.text).toContain('[auth]');
  expect(created.text).toContain('theme = "dark"');

  const inline = editTomlFields(
    'endpoints = { other = "keep" }\n',
    [{ path: ['endpoints', 'x'], next: { present: true, value: 'y' } }],
    { tomlVersion: '1.0' },
  );
  expect(inline.createdTables).toEqual([]);
});

test('TOML 1.0 rejects 1.1 inline trailing commas that 1.1 accepts', () => {
  const source = 'x = { a = "y", }\n';
  expect(() => readTomlField(source, ['x', 'a'], { tomlVersion: '1.0' })).toThrow('Invalid TOML document');
  expect(readTomlField(source, ['x', 'a'], { tomlVersion: '1.1' })).toMatchObject({ present: true, value: 'y' });
});

test('inserts siblings into an implicit dotted-key table without a new header', () => {
  const source = 'endpoints.keep = "x"\n';
  const result = editTomlFields(
    source,
    [{ path: ['endpoints', 'models_base_url'], next: { present: true, value: 'http://127.0.0.1:9/v1' } }],
    { tomlVersion: '1.0' },
  );
  expect(result.text).not.toContain('[endpoints]');
  expect(result.text).toContain('endpoints.keep = "x"');
  expect(result.text).toContain('endpoints.models_base_url');
  expect(result.createdTables).toEqual([]);
  const parsed = Bun.TOML.parse(result.text) as {
    readonly endpoints: { readonly keep: string; readonly models_base_url: string };
  };
  expect(parsed.endpoints.keep).toBe('x');
  expect(parsed.endpoints.models_base_url).toBe('http://127.0.0.1:9/v1');
});

test('collects dotted implicit parent paths without joining segments', () => {
  const inspected = inspectTomlPaths('model_providers.proxy.name = "x"\n', { tomlVersion: '1.1' });
  expect(inspected.fieldPaths).toContainEqual(['model_providers', 'proxy', 'name']);
  expect(inspected.tablePaths).toContainEqual(['model_providers']);
  expect(inspected.tablePaths).toContainEqual(['model_providers', 'proxy']);
});
