import { m } from '@aio-proxy/i18n';
import { expect, test } from '@rstest/core';

import { blockingSections, type SectionStatusInput, type SectionSummary, sectionStatuses } from './section-status';

const base = {
  kind: 'api' as const,
  mode: 'create' as const,
  id: 'p1',
  baseURL: 'https://x.example/v1',
  protocol: 'openai-compatible',
  apiKey: 'sk-test',
  models: ['m1'],
  aliasIssues: [],
  transformsValid: true,
  weightTie: false,
};

/** Statuses only, so the pre-hint status assertions stay readable. */
const statuses = (input: SectionStatusInput) => {
  const summaries = sectionStatuses(input);
  return {
    identity: summaries.identity.status,
    connection: summaries.connection.status,
    models: summaries.models.status,
    routing: summaries.routing.status,
    advanced: summaries.advanced.status,
  };
};

const summary = (status: SectionSummary['status']): SectionSummary => ({ status, hint: '' });

test('an empty baseURL on an api provider is todo and blocks; an empty apiKey is not', () => {
  const summaries = sectionStatuses({ ...base, baseURL: '' });
  expect(summaries.connection.status).toBe('todo');
  expect(blockingSections(summaries)).toEqual(['connection']);
  expect(statuses(base).connection).toBe('ok');
  // `baseURL: ''` short-circuits the `||` before `protocol` is read, so the protocol half needs
  // its own case. Use `undefined`, not `''`: `defaultValues: { ...initial, kind }` leaves the field
  // absent on a fresh api draft, so `undefined` is the real state AND it also pins the `?? ''`.
  expect(statuses({ ...base, protocol: undefined }).connection).toBe('todo');
  // ai-sdk drafts carry neither field; widening the guard to `!== 'oauth'` would make their
  // connection permanently todo, i.e. an unsaveable-looking draft.
  expect(statuses({ ...base, kind: 'ai-sdk', baseURL: undefined, protocol: undefined }).connection).toBe('ok');
});

// The editor form carries no validators by design, so `sectionStatuses` is the only save gate. The
// body it dispatches parses `baseURL` with `z.url()`, so a non-empty string that is not a URL used to
// buy a green dot, an enabled Save, and a rejected mutation.
test('a non-empty but unparseable baseURL is todo, exactly as an empty one is', () => {
  const summaries = sectionStatuses({ ...base, baseURL: 'api.example.com' });
  expect(summaries.connection.status).toBe('todo');
  expect(summaries.connection.hint).toBe(m['dashboard.providers.editor.hint_connection_bad_base_url']());
  expect(blockingSections(summaries)).toEqual(['connection']);
  // `{{...}}` is accepted by the authoring schemas but NOT by the mutation body the editor sends, so
  // tolerating it here would restore the same green-dot-then-toast path.
  expect(statuses({ ...base, baseURL: '{{env.OPENAI_BASE_URL}}' }).connection).toBe('todo');
  // Deliberately stricter than `z.url()`, which accepts any scheme: the proxy reaches an upstream over
  // http(s) only, so an `ftp://` origin is an unconnected section however well it parses.
  expect(statuses({ ...base, baseURL: 'ftp://x.example' }).connection).toBe('todo');
  // And the guard must not make every api provider a todo.
  expect(statuses(base).connection).toBe('ok');
  expect(statuses({ ...base, baseURL: 'http://localhost:8080/v1' }).connection).toBe('ok');
});

test('blocking sections come back in rail order, whatever order the statuses were built in', () => {
  // Keys deliberately out of SECTION_ORDER: a naive `Object.keys(statuses).filter(...)` would
  // return ['advanced', 'identity'] and mis-order the save-blocking footer.
  expect(
    blockingSections({
      advanced: summary('todo'),
      identity: summary('todo'),
      connection: summary('ok'),
      models: summary('ok'),
      routing: summary('ok'),
    }),
  ).toEqual(['identity', 'advanced']);
});

test('an empty provider id blocks in create mode only', () => {
  expect(statuses({ ...base, id: '' }).identity).toBe('todo');
  expect(statuses({ ...base, id: '', mode: 'edit' }).identity).toBe('ok');
});

test('alias issues raise models to todo because the schema would reject the save', () => {
  const aliasIssues = [{ code: 'target-missing' as const, alias: 'smart' }];
  expect(statuses({ ...base, aliasIssues }).models).toBe('todo');
  // The alias editor lives in Models now (D-F6), so Routing must not carry a dot for a control it no
  // longer holds — and todo there would send the footer's "complete these sections" to the wrong one.
  expect(statuses({ ...base, aliasIssues }).routing).toBe('ok');
});

test('a stale whitelist entry is attention and does not block', () => {
  const summaries = sectionStatuses({
    ...base,
    kind: 'oauth',
    capabilityKey: 'p\0c',
    authorized: true,
    models: ['gone'],
    discoveredModels: ['here'],
  });
  expect(summaries.models.status).toBe('attention');
  expect(blockingSections(summaries)).toEqual([]);
  // Staleness is only computed when a catalog was fetched. Dropping that guard makes
  // `new Set(undefined)` empty, so every whitelisted model reads as stale on every provider.
  expect(statuses(base).models).toBe('ok');
});

test('a weight tie is attention on routing', () => {
  expect(statuses({ ...base, weightTie: true }).routing).toBe('attention');
});

test('an oauth provider needs a capability, but never its own id — the server assigns that', () => {
  const summaries = statuses({
    ...base,
    kind: 'oauth',
    id: '',
    capabilityKey: '',
    models: [],
  });
  expect(summaries.connection).toBe('todo');
  // Same empty id is a todo for api/ai-sdk (test above); dropping the `kind !== 'oauth'`
  // guard in `identity` must red HERE, since nothing else exercises that clause.
  expect(summaries.identity).toBe('ok');
  // An `ok` identity with no id still has to say something: without the fallback the badge is a
  // lone dot on the oauth create screen.
  expect(sectionStatuses({ ...base, kind: 'oauth', id: '', capabilityKey: '', models: [] }).identity.hint).toBe(
    m['dashboard.providers.editor.hint_identity_server_assigned'](),
  );
});

test('a provider that would route nothing is todo; aliases alone are enough to be ready', () => {
  // Zero exposed models means `modelRoutes` yields nothing, so the save produces a provider no
  // request can ever reach.
  const empty = sectionStatuses({ ...base, models: [] });
  expect(empty.models.status).toBe('todo');
  expect(blockingSections(empty)).toEqual(['models']);
  expect(empty.models.hint).toBe(m['dashboard.providers.editor.hint_models_todo']());
  // Alias-only providers ship an empty whitelist and still expose routes; blocking them would put
  // an uncleanable entry in the save-blocking footer.
  expect(statuses({ ...base, models: [], aliasCount: 1 }).models).toBe('ok');
  // oauth's empty whitelist means "expose the whole catalog", so it is ready even when the catalog
  // could not be fetched (`catalog_unavailable`) — the user has nothing to fix there.
  expect(statuses({ ...base, kind: 'oauth', capabilityKey: 'p\0c', models: [] }).models).toBe('ok');
});

test('invalid transforms JSON blocks the advanced section', () => {
  expect(statuses({ ...base, transformsValid: false }).advanced).toBe('todo');
});

test('invalid ai-sdk options block the connection section and do not leak onto api', () => {
  expect(statuses({ ...base, kind: 'ai-sdk', optionsValid: false }).connection).toBe('todo');
  expect(statuses({ ...base, optionsValid: false }).connection).toBe('ok');
});

// A blank package name fails AiSdkPackageNameSchema's `min(1)`, so the save it allows today can only
// come back as a toast. `undefined` is a different state: the schema defaults it.
test('an explicitly emptied ai-sdk package name is todo and names itself', () => {
  const summaries = sectionStatuses({ ...base, kind: 'ai-sdk', packageName: '  ' });
  expect(summaries.connection.status).toBe('todo');
  expect(summaries.connection.hint).toBe(m['dashboard.providers.editor.hint_connection_todo_ai_sdk']());
  expect(statuses({ ...base, kind: 'ai-sdk', packageName: undefined }).connection).toBe('ok');
});

test('a missing api key is attention and never blocks the save', () => {
  const summaries = sectionStatuses({ ...base, apiKey: '' });
  expect(summaries.connection.status).toBe('attention');
  expect(summaries.connection.hint).toBe(m['dashboard.providers.editor.hint_connection_no_api_key']());
  // D-F2: widening `blockingSections` past 'todo' would disable Save here, and in edit mode an empty
  // field means "keep the stored key", so the section is complete.
  expect(blockingSections(summaries)).toEqual([]);
  expect(statuses({ ...base, apiKey: '', mode: 'edit' }).connection).toBe('ok');
});

test('a ready api connection reads as the host, not the whole URL', () => {
  expect(sectionStatuses(base).connection.hint).toBe('x.example/v1');
});

test('a ready oauth connection is authorized, an unauthorized one is attention', () => {
  const pending = sectionStatuses({ ...base, kind: 'oauth', capabilityKey: 'p\0c', authorized: false });
  expect(pending.connection.status).toBe('attention');
  expect(pending.connection.hint).toBe(m['dashboard.providers.editor.hint_connection_oauth_unauthorized']());
  // Authorizing is what the primary button does in oauth create; blocking it would deadlock the flow.
  expect(blockingSections(pending)).toEqual([]);
  const done = sectionStatuses({ ...base, kind: 'oauth', capabilityKey: 'p\0c', authorized: true });
  expect(done.connection.hint).toBe(m['dashboard.providers.editor.hint_connection_oauth_ready']());
});

// D-F5: the display name is optional, and `SectionStatusInput` deliberately carries no `name` for
// identity to inspect. Editing a historical provider without one must not deadlock Save.
test('identity is ready on a filled id alone and reads as that id', () => {
  const identity = sectionStatuses(base).identity;
  expect(identity.status).toBe('ok');
  expect(identity.hint).toBe('p1');
  expect(sectionStatuses({ ...base, id: '' }).identity.hint).toBe(m['dashboard.providers.editor.hint_identity_todo']());
});

test('a models hint with no aliases counts models only', () => {
  // The shortcut to avoid: one message with `aliases: 0`, which prints "3 models · 0 aliases".
  expect(sectionStatuses({ ...base, models: ['a', 'b', 'c'] }).models.hint).toBe(
    m['dashboard.providers.editor.hint_models_count_models']({ count: 3 }),
  );
  expect(sectionStatuses({ ...base, models: ['a', 'b', 'c'], aliasCount: 2 }).models.hint).toBe(
    `${m['dashboard.providers.editor.hint_models_count_models']({ count: 3 })} · ${m['dashboard.providers.form.aliases_summary_aliases']({ count: 2 })}`,
  );
  // An empty whitelist exposes the discovered catalog, so the count comes from it.
  expect(sectionStatuses({ ...base, models: [], discoveredModels: ['a', 'b'] }).models.hint).toBe(
    m['dashboard.providers.editor.hint_models_count_models']({ count: 2 }),
  );
  expect(sectionStatuses({ ...base, models: [] }).models.hint).toBe(m['dashboard.providers.editor.hint_models_todo']());
});

test('a disabled provider reads as disabled, never as a weight it will not honour', () => {
  // A disabled provider is never materialized, so printing "weight 40" states something the router
  // will not do.
  expect(sectionStatuses({ ...base, enabled: false, weight: 40 }).routing.hint).toBe(
    m['dashboard.providers.editor.hint_routing_disabled'](),
  );
  expect(sectionStatuses({ ...base, enabled: true, weight: 40 }).routing.hint).toBe(
    m['dashboard.providers.editor.hint_routing_weight']({ weight: 40 }),
  );
  // Absent coalesces to 0 for *ordering*, but the readout keeps the two apart: the attempt-order
  // queue beside this badge renders a dash for absent, and a stored 0 must stay distinguishable
  // from a key that was never written. `section-hint.test.ts` pins all three states at the unit.
  expect(sectionStatuses(base).routing.hint).toBe(m['dashboard.providers.editor.hint_routing_no_weight']());
});

test('routing states its own problem before its weight', () => {
  expect(sectionStatuses({ ...base, weightTie: true }).routing.hint).toBe(
    m['dashboard.providers.editor.hint_routing_weight_tie'](),
  );
});

// A disabled provider is never materialized, so it joins no attempt queue — which makes a tie inside
// that queue exactly as untrue of it as the weight the branch above already suppresses.
test('a disabled provider reads as disabled even when its weight ties', () => {
  const summaries = sectionStatuses({ ...base, enabled: false, weightTie: true, weight: 40 });
  expect(summaries.routing.hint).toBe(m['dashboard.providers.editor.hint_routing_disabled']());
  // The dot stays on the tie (D-F6). This is the hint's ordering, not the status'.
  expect(summaries.routing.status).toBe('attention');
});

test('the advanced hint joins exactly the parts that are active', () => {
  expect(sectionStatuses({ ...base, headerCount: 2, proxyCustom: true, transformCount: 0 }).advanced.hint).toBe(
    [
      m['dashboard.providers.editor.hint_advanced_headers']({ count: 2 }),
      m['dashboard.providers.editor.hint_advanced_proxy'](),
    ].join(' · '),
  );
  expect(sectionStatuses({ ...base, transformCount: 3 }).advanced.hint).toBe(
    m['dashboard.providers.editor.hint_advanced_transforms']({ count: 3 }),
  );
  expect(sectionStatuses(base).advanced.hint).toBe(m['dashboard.providers.editor.hint_advanced_defaults']());
});

// Unparseable JSON leaves `transformCount` on the last valid value, so counting alone reads
// "All defaults" beside a hollow dot while the footer demands the section be completed.
test('a save-blocking advanced section never reads as defaults', () => {
  const summaries = sectionStatuses({ ...base, transformsValid: false, headerCount: 0, transformCount: 0 });
  expect(summaries.advanced.status).toBe('todo');
  expect(summaries.advanced.hint).toBe(m['dashboard.providers.editor.hint_advanced_todo']());
});

test('a stale whitelist names staleness rather than the model count', () => {
  expect(sectionStatuses({ ...base, models: ['gone'], discoveredModels: ['here'] }).models.hint).toBe(
    m['dashboard.providers.editor.hint_models_stale'](),
  );
});
