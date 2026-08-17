import { describe, expect, test } from '@rstest/core';

import { createCodeEditorContentAttributes } from './code-editor-accessibility';

describe('code editor accessibility', () => {
  test('mirrors invalid state onto the editable surface', () => {
    expect(createCodeEditorContentAttributes({ invalid: true, id: 'options' })).toEqual({
      id: 'options',
      'aria-invalid': 'true',
      'aria-describedby': 'options-error',
    });
    expect(createCodeEditorContentAttributes({ invalid: false, id: 'options' })).toEqual({ id: 'options' });
    expect(createCodeEditorContentAttributes({ invalid: true })).toEqual({ 'aria-invalid': 'true' });
  });
});
