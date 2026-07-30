import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { ProviderRequestTransformsEditor } from './provider-request-transforms-editor';

rs.mock('@/components/json-editor/json-editor', () => ({
  JsonEditor: ({ ariaLabel, onValidationChange, onValueChange, value }: any) => {
    const [draft, setDraft] = useState(JSON.stringify(value, null, 2));
    return (
      <textarea
        aria-label={ariaLabel}
        value={draft}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraft(nextDraft);
          try {
            onValueChange(JSON.parse(nextDraft));
            onValidationChange({ valid: true });
          } catch {
            onValidationChange({ valid: false });
          }
        }}
      />
    );
  },
}));

const initialValue: readonly ProviderRequestTransformRule[] = [{ update: [{ $unset: 'request.body.store' }] }];

test('edits the request rule array without exposing the transforms wrapper', async () => {
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  render(
    <ProviderRequestTransformsEditor value={initialValue} onChange={onChange} onValidityChange={onValidityChange} />,
  );

  const editor = await screen.findByRole('textbox', { name: /request transforms json/i });
  expect((editor as HTMLTextAreaElement).value).toContain('"$unset": "request.body.store"');
  expect((editor as HTMLTextAreaElement).value).not.toContain('"request"');

  fireEvent.change(editor, { target: { value: '{' } });
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.change(editor, { target: { value: '[{"update":[{"$project":{"request.body":1}}]}]' } });
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('REQUEST_TRANSFORM_STAGE_INVALID');

  fireEvent.change(editor, { target: { value: '[{"update":[{"$set":{"request.body.store":false}}]}]' } });
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith([{ update: [{ $set: { 'request.body.store': false } }] }]),
  );
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
});
