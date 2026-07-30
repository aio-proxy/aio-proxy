import { m } from '@aio-proxy/i18n';
import type { ProviderRequestTransformRule } from '@aio-proxy/types';

import { ProviderRequestTransformsJsonEditor } from './provider-request-transforms-json-editor';

export interface ProviderRequestTransformsEditorProps {
  readonly value: readonly ProviderRequestTransformRule[];
  readonly onChange: (value: readonly ProviderRequestTransformRule[]) => void;
  readonly onValidityChange: (valid: boolean) => void;
}

export const ProviderRequestTransformsEditor: React.FC<ProviderRequestTransformsEditorProps> = ({
  value,
  onChange,
  onValidityChange,
}) => (
  <section className="space-y-4 border-t pt-6" aria-labelledby="provider-request-transforms-heading">
    <div className="space-y-1">
      <h2 id="provider-request-transforms-heading" className="text-base font-semibold">
        {m['dashboard.providers.transforms.section']()}
      </h2>
      <p className="text-sm text-muted-foreground">{m['dashboard.providers.transforms.description']()}</p>
      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m['dashboard.providers.transforms.empty']()}</p>
      ) : null}
    </div>
    <ProviderRequestTransformsJsonEditor value={value} onChange={onChange} onValidityChange={onValidityChange} />
  </section>
);
