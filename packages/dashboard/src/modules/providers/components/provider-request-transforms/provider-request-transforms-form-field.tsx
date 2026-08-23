import type { ProviderTransforms } from '@aio-proxy/types';

import type { ProviderEditorForm } from '../../hooks/use-provider-editor-form';
import { ProviderRequestTransformsEditor } from './provider-request-transforms-editor';

interface ProviderRequestTransformsFormFieldProps {
  readonly form: ProviderEditorForm;
  readonly onValidityChange: (valid: boolean) => void;
}

export const ProviderRequestTransformsFormField: React.FC<ProviderRequestTransformsFormFieldProps> = ({
  form,
  onValidityChange,
}) => (
  <form.Field name="transforms">
    {(field) => {
      const transforms = field.state.value as ProviderTransforms | undefined;
      return (
        <ProviderRequestTransformsEditor
          value={transforms?.request ?? []}
          onChange={(request) => field.handleChange({ request })}
          onValidityChange={onValidityChange}
        />
      );
    }}
  </form.Field>
);
