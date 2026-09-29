import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { useModelReference } from '../hooks/use-model-reference';
import {
  CAPABILITY_KEYS,
  CAPABILITY_LABEL,
  LIMIT_KEYS,
  LIMIT_LABEL,
  type MetadataRecord,
  booleanAt,
  formatTokens,
  numberAt,
} from '../lib/model-metadata-fields';
import { RoutingProfileValue } from './routing-profile-value';

interface RoutingModelInfoCardProps {
  readonly modelId: string;
  readonly metadata: MetadataRecord | undefined;
  readonly writable: boolean;
  readonly onEdit: () => void;
}

/** The model's effective info at a glance; editing happens in the drawer. */
export const RoutingModelInfoCard: React.FC<RoutingModelInfoCardProps> = ({ modelId, metadata, writable, onEdit }) => {
  const { slug, matched, inherited } = useModelReference(modelId, metadata);
  const reference = inherited as MetadataRecord | undefined;
  const ownName = typeof metadata?.['name'] === 'string' ? metadata['name'] : undefined;
  const referenceName = typeof reference?.['name'] === 'string' ? reference['name'] : undefined;

  return (
    <Card size="sm" data-testid="routing-model-info-card">
      <CardHeader>
        <CardTitle>{m['dashboard.routing.profile.info_title']()}</CardTitle>
        <CardAction>
          <Button type="button" size="sm" variant="outline" onClick={onEdit}>
            {writable ? m['dashboard.routing.profile.edit']() : m['dashboard.routing.profile.view']()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">{m['dashboard.routing.profile.reference']()}</dt>
          <dd
            className="min-w-0 truncate text-right font-mono text-xs leading-5"
            title={matched ? m['dashboard.routing.profile.reference_matched']() : undefined}
          >
            {slug === '' ? m['dashboard.routing.profile.reference_none']() : slug}
          </dd>
          <RoutingProfileValue
            label={m['dashboard.routing.editor.metadata_field_label_name']()}
            own={ownName}
            inherited={referenceName}
          />
          {LIMIT_KEYS.map((key) => {
            const own = numberAt(metadata, 'limit', key);
            const inheritedValue = numberAt(reference, 'limit', key);
            return (
              <RoutingProfileValue
                key={key}
                label={LIMIT_LABEL[key]()}
                own={own === undefined ? undefined : formatTokens(own)}
                inherited={inheritedValue === undefined ? undefined : formatTokens(inheritedValue)}
              />
            );
          })}
        </dl>
        <ul className="flex flex-wrap gap-1.5" aria-label={m['dashboard.routing.editor.metadata_group_capabilities']()}>
          {CAPABILITY_KEYS.flatMap((key) => {
            const own = booleanAt(metadata, 'capabilities', key);
            const supported = own ?? booleanAt(reference, 'capabilities', key);
            if (supported === undefined) return [];
            return [
              <li
                key={key}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                  !supported && 'text-muted-foreground line-through',
                  own !== undefined && 'border-primary',
                )}
              >
                {CAPABILITY_LABEL[key]()}
              </li>,
            ];
          })}
        </ul>
      </CardContent>
    </Card>
  );
};
