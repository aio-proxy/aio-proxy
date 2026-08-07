import { m } from '@aio-proxy/i18n';
import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aio-proxy/ui/components/tabs';
import { useEffect, useMemo, useState } from 'react';

import { parseRequestTransformCondition, parseRequestTransformStages } from '../../lib/request-transforms';
import { ProviderRequestTransformsJsonEditor } from './provider-request-transforms-json-editor';
import { ProviderRequestTransformsVisualEditor } from './provider-request-transforms-visual-editor';

const canEditVisually = (rules: readonly ProviderRequestTransformRule[]): boolean => {
  try {
    for (const rule of rules) {
      if (rule.when !== undefined) parseRequestTransformCondition(rule.when);
      parseRequestTransformStages(rule.update);
    }
    return true;
  } catch {
    return false;
  }
};

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
  const [visualValid, setVisualValid] = useState(true);
  const [jsonValid, setJsonValid] = useState(true);
  const visualCompatible = useMemo(() => canEditVisually(value), [value]);
  const activeMode = visualCompatible ? mode : 'json';

  useEffect(() => {
    if (!visualCompatible) setMode('json');
  }, [visualCompatible]);

  useEffect(() => {
    onValidityChange(activeMode === 'visual' ? visualValid : jsonValid);
  }, [activeMode, jsonValid, onValidityChange, visualValid]);

  const changeMode = (nextMode: string) => {
    if (nextMode === 'json' && !visualValid) return;
    if (nextMode === 'visual' && (!jsonValid || !visualCompatible)) return;
    if (nextMode === 'visual' || nextMode === 'json') setMode(nextMode);
  };

  return (
    <section className="space-y-4 border-t pt-6" aria-labelledby="provider-request-transforms-heading">
      <div className="space-y-1">
        <h2 id="provider-request-transforms-heading" className="text-base font-semibold">
          {m['dashboard.providers.transforms.section']()}
        </h2>
        <p className="text-sm text-muted-foreground">{m['dashboard.providers.transforms.description']()}</p>
      </div>
      <Tabs value={activeMode} onValueChange={changeMode}>
        <TabsList>
          <TabsTrigger value="visual" disabled={!jsonValid || !visualCompatible}>
            {m['dashboard.providers.transforms.mode.visual']()}
          </TabsTrigger>
          <TabsTrigger value="json" disabled={!visualValid}>
            JSON
          </TabsTrigger>
        </TabsList>
        <TabsContent value="visual">
          <ProviderRequestTransformsVisualEditor value={value} onChange={onChange} onValidityChange={setVisualValid} />
        </TabsContent>
        <TabsContent value="json">
          <ProviderRequestTransformsJsonEditor value={value} onChange={onChange} onValidityChange={setJsonValid} />
        </TabsContent>
      </Tabs>
    </section>
  );
};
