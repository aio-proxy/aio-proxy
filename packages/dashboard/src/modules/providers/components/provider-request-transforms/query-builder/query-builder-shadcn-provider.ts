import type { ControlElementsProp, FullField } from 'react-querybuilder';
import { getCompatContextProvider } from 'react-querybuilder';

import { QueryBuilderActionElement } from './query-builder-action-element';
import { QueryBuilderNotToggle } from './query-builder-not-toggle';
import { QueryBuilderShiftActions } from './query-builder-shift-actions';
import { QueryBuilderValueEditor } from './query-builder-value-editor';
import { QueryBuilderValueSelector } from './query-builder-value-selector';

// Adapted from react-querybuilder registry commit 389b271cadc54080d4ad096d5b3ab57db5d688c4 (MIT License).
const queryBuilderShadcnControlElements: ControlElementsProp<FullField, string> = {
  actionElement: QueryBuilderActionElement,
  notToggle: QueryBuilderNotToggle,
  shiftActions: QueryBuilderShiftActions,
  valueEditor: QueryBuilderValueEditor,
  valueSelector: QueryBuilderValueSelector,
};

export const queryBuilderShadcnProvider = getCompatContextProvider({
  controlElements: queryBuilderShadcnControlElements,
});
