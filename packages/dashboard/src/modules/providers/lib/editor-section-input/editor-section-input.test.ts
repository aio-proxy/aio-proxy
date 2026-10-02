import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { toAliasRows } from '../alias-editor';
import { ProviderFormMode } from '../constants';
import { sectionStatuses } from '../section-status';
import { editorSectionInput } from './editor-section-input';

const extras = {
  authorized: true,
  capabilityKey: '',
  discoveredModels: ['a', 'b'],
  hasApiKey: false,
  optionsValid: true,
  transformsValid: true,
  transformCount: 0,
};

test('sync section status counts exposed models and accepts aliases to hidden discovered targets', () => {
  const values = {
    kind: ProviderKind.AiSdk,
    id: 'p',
    syncModels: true,
    models: [],
    excludedModels: ['b'],
    alias: toAliasRows({ fast: { model: 'b', preserve: false } }),
  };
  const input = editorSectionInput(values, values.kind, ProviderFormMode.Edit, extras);
  expect(input.aliasIssues).toEqual([]);
  expect(sectionStatuses(input).models).toEqual({
    status: 'ok',
    hint: `${m['dashboard.providers.editor.hint_models_count_model']({ count: 1 })} · ${m['dashboard.providers.form.aliases_summary_alias']({ count: 1 })}`,
  });
});

test('hiding all synced models blocks an empty Provider but an undiscovered catalog stays saveable', () => {
  const values = { kind: ProviderKind.Api, id: 'p', syncModels: true, models: [], excludedModels: ['a', 'b'] };
  expect(sectionStatuses(editorSectionInput(values, values.kind, ProviderFormMode.Edit, extras)).models.status).toBe(
    'todo',
  );
  expect(
    sectionStatuses(
      editorSectionInput(values, values.kind, ProviderFormMode.Edit, { ...extras, discoveredModels: undefined }),
    ).models.status,
  ).toBe('ok');
});

test('manual section inputs continue validating alias targets against authored models', () => {
  const values = {
    kind: ProviderKind.AiSdk,
    id: 'p',
    models: ['a'],
    alias: toAliasRows({ fast: { model: 'b', preserve: false } }),
  };
  const input = editorSectionInput(values, values.kind, ProviderFormMode.Edit, extras);
  expect(input.aliasIssues).toEqual([expect.objectContaining({ code: 'target-missing' })]);
  expect(sectionStatuses(input).models.status).toBe('todo');
});
