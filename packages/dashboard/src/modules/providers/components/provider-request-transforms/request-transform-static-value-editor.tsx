import { m } from '@aio-proxy/i18n';
import type { JsonValue } from '@aio-proxy/plugin-sdk';

import { JsonEditor } from '@/components/json-editor';
import type { JsonValue as EditorJsonValue } from '@/components/json-editor/json-editor-state';

export interface RequestTransformStaticValueEditorProps {
  readonly value: JsonValue;
  readonly onChange: (value: JsonValue) => void;
}

export const RequestTransformStaticValueEditor: React.FC<RequestTransformStaticValueEditorProps> = ({
  value,
  onChange,
}) => (
  <JsonEditor
    value={value as EditorJsonValue}
    height={120}
    ariaLabel={m['dashboard.providers.transforms.value.static_label']()}
    onValueChange={(nextValue, _draft, expectValueAcknowledgement) => {
      if (nextValue === undefined) return;
      expectValueAcknowledgement(nextValue);
      onChange(nextValue);
    }}
  />
);
