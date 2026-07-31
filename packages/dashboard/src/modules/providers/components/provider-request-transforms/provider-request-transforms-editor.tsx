import { m } from '@aio-proxy/i18n';
import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import { useEffect, useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { ProviderRequestTransformsJsonEditor } from './provider-request-transforms-json-editor';
import { ProviderRequestTransformsVisualEditor } from './provider-request-transforms-visual-editor';

export interface ProviderRequestTransformsEditorProps {
  readonly value: readonly ProviderRequestTransformRule[];
  readonly onChange: (value: readonly ProviderRequestTransformRule[]) => void;
  readonly onValidityChange: (valid: boolean) => void;
}

export const ProviderRequestTransformsEditor: React.FC<ProviderRequestTransformsEditorProps> = ({
  value,
  onChange,
  onValidityChange,
}) => {
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const [jsonValid, setJsonValid] = useState(true);

  useEffect(() => {
    if (mode === 'visual') onValidityChange(true);
  }, [mode, onValidityChange]);

  return (
    <section className="space-y-4 border-t pt-6" aria-labelledby="provider-request-transforms-heading">
      <div className="space-y-1">
        <h2 id="provider-request-transforms-heading" className="text-base font-semibold">
          {m['dashboard.providers.transforms.section']()}
        </h2>
        <p className="text-sm text-muted-foreground">{m['dashboard.providers.transforms.description']()}</p>
      </div>
      <Tabs value={mode} onValueChange={(nextMode) => setMode(nextMode as 'visual' | 'json')}>
        <TabsList>
          <TabsTrigger value="visual" disabled={!jsonValid}>
            {m['dashboard.providers.transforms.mode.visual']()}
          </TabsTrigger>
          <TabsTrigger value="json">{m['dashboard.providers.transforms.mode.json']()}</TabsTrigger>
        </TabsList>
        <TabsContent value="visual">
          <ProviderRequestTransformsVisualEditor value={value} onChange={onChange} />
        </TabsContent>
        <TabsContent value="json">
          <ProviderRequestTransformsJsonEditor
            value={value}
            onChange={onChange}
            onValidityChange={(valid) => {
              setJsonValid(valid);
              onValidityChange(valid);
            }}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
};
