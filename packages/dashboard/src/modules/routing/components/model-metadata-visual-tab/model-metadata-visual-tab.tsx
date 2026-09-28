import { m } from '@aio-proxy/i18n';
import { Input } from '@aio-proxy/ui/components/input';
import { Switch } from '@aio-proxy/ui/components/switch';
import { Textarea } from '@aio-proxy/ui/components/textarea';
import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import { useState } from 'react';

import { useModelReference } from '../../hooks/use-model-reference';
import {
  CAPABILITY_KEYS,
  CAPABILITY_LABEL,
  LIMIT_KEYS,
  LIMIT_LABEL,
  PRICE_LABEL,
  PRICE_MAIN_KEYS,
  PRICE_MORE_KEYS,
  PRICE_UNIT,
  type MetadataRecord,
  type PriceKey,
  booleanAt,
  formatTokens,
  numberAt,
  objectAt,
  tiersAt,
  withKey,
  withNested,
} from '../../lib/model-metadata-fields';
import { modelsDevLookupQueryOptions } from '../../services/models-dev-service';
import { ModelMetadataCapabilityField } from './model-metadata-capability-field';
import { ModelMetadataExtendField } from './model-metadata-extend-field';
import { ModelMetadataGroup } from './model-metadata-group';
import { ModelMetadataMorePrices } from './model-metadata-more-prices';
import { ModelMetadataNumberField } from './model-metadata-number-field';
import { ModelMetadataOverrideRow } from './model-metadata-override-row';
import { ModelMetadataTiers } from './model-metadata-tiers';

interface ModelMetadataVisualTabProps {
  /** Public slug of the model being edited; used to suggest a reference model. */
  readonly model: string;
  readonly value: MetadataRecord;
  readonly onChange: (value: MetadataRecord) => void;
}

/**
 * The model-level fields as "follow the reference model, or override". Each field has its own
 * switch; turning it on seeds the input with the reference value, so an override starts from what
 * the model already reports instead of from a blank the user has to look up.
 */
export const ModelMetadataVisualTab: React.FC<ModelMetadataVisualTabProps> = ({ model, value, onChange: emit }) => {
  const { slug, matched, inherited, pending: referencePending } = useModelReference(model, value);
  const inheritedRecord = inherited as MetadataRecord | undefined;

  // The first override of a model that follows its automatic match writes that match into `extend`,
  // so the saved metadata names what it inherits from instead of relying on the model ID lookup. When
  // every override is undone, an `extend` that only repeats the automatic match is taken back out:
  // without it the proxy falls back to that same model, so keeping it would save a change that says
  // nothing. This is read off the value itself rather than remembered, because the drawer unmounts
  // this form on close and a remembered flag would not survive to the undo.
  const automaticMatch = useQuery(modelsDevLookupQueryOptions(model)).data?.slug ?? undefined;
  const onChange = (next: MetadataRecord) => {
    const { extend: nextExtend, ...fields } = next;
    const overrides = Object.keys(fields).length > 0;
    if (matched && overrides) emit({ extend: slug, ...fields });
    else if (!overrides && nextExtend !== undefined && nextExtend === automaticMatch) emit(fields);
    else emit(next);
  };

  // A switch turned on for a field the reference model lacks has no value to seed, and an absent key
  // is how "not overridden" is stored. These keys remember the switch until something is typed.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const setPendingKey = (key: string, on: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const numberRow = (
    group: 'limit' | 'cost',
    key: string,
    label: string,
    unit: string | undefined,
    format: (n: number) => string,
  ) => {
    const pendingKey = `${group}.${key}`;
    const own = numberAt(value, group, key);
    const reference = numberAt(inheritedRecord, group, key);
    const id = `metadata-${group}-${key}`;
    return (
      <ModelMetadataOverrideRow
        disabled={referencePending}
        key={pendingKey}
        id={id}
        label={label}
        unit={unit}
        overridden={own !== undefined || pending.has(pendingKey)}
        inherited={reference === undefined ? undefined : format(reference)}
        onOverriddenChange={(on) => {
          setPendingKey(pendingKey, on && reference === undefined);
          onChange(withNested(value, group, key, on ? reference : undefined));
        }}
      >
        <ModelMetadataNumberField
          id={id}
          label={label}
          labelHidden
          min={group === 'limit' ? 1 : 0}
          step={group === 'limit' ? 1 : 'any'}
          placeholder={reference === undefined ? '' : String(reference)}
          unit={unit}
          value={own}
          onValueChange={(next) => {
            if (next !== undefined) setPendingKey(pendingKey, false);
            onChange(withNested(value, group, key, next));
          }}
        />
      </ModelMetadataOverrideRow>
    );
  };

  const textRow = (key: 'name' | 'description') => {
    const own = typeof value[key] === 'string' ? value[key] : undefined;
    const reference = typeof inherited?.[key] === 'string' ? inherited[key] : undefined;
    const id = `metadata-${key}`;
    const label =
      key === 'name'
        ? m['dashboard.routing.editor.metadata_field_label_name']()
        : m['dashboard.routing.editor.metadata_field_label_description']();
    const write = (next: string | undefined) => onChange(withKey(value, key, next === '' ? undefined : next));
    return (
      <ModelMetadataOverrideRow
        disabled={referencePending}
        id={id}
        label={label}
        overridden={own !== undefined || pending.has(key)}
        inherited={reference}
        onOverriddenChange={(on) => {
          setPendingKey(key, on && reference === undefined);
          write(on ? reference : undefined);
        }}
      >
        {key === 'name' ? (
          <Input id={id} value={own ?? ''} onChange={(event) => write(event.target.value)} />
        ) : (
          <Textarea id={id} rows={2} value={own ?? ''} onChange={(event) => write(event.target.value)} />
        )}
      </ModelMetadataOverrideRow>
    );
  };

  // The unit sits in the field, so a followed price reads as the bare number the override would edit.
  const priceRow = (key: PriceKey) => numberRow('cost', key, PRICE_LABEL[key](), PRICE_UNIT[key](), String);
  const ownTiers = tiersAt(value);
  const referenceTiers = tiersAt(inheritedRecord) ?? [];

  const tiersOverridden = ownTiers !== undefined;

  return (
    <div className="space-y-6">
      <ModelMetadataGroup titleId="metadata-extend-title" title={m['dashboard.routing.editor.metadata_group_extend']()}>
        <ModelMetadataExtendField
          slug={slug}
          matched={matched}
          onValueChange={(next) => {
            // A pick or clear goes straight to the draft; it is not an override to pin a match for.
            emit(withKey(value, 'extend', next));
          }}
        />
      </ModelMetadataGroup>

      <ModelMetadataGroup
        titleId="metadata-display-title"
        title={m['dashboard.routing.editor.metadata_group_display']()}
        hint={m['dashboard.routing.profile.override_hint']()}
      >
        <div className="space-y-2">
          {textRow('name')}
          {textRow('description')}
          {LIMIT_KEYS.map((key) => numberRow('limit', key, LIMIT_LABEL[key](), undefined, formatTokens))}
        </div>
      </ModelMetadataGroup>

      <ModelMetadataGroup
        titleId="metadata-capability-title"
        title={m['dashboard.routing.editor.metadata_group_capabilities']()}
      >
        <div className="space-y-2">
          {CAPABILITY_KEYS.map((key) => (
            <ModelMetadataCapabilityField
              key={key}
              capability={key}
              label={CAPABILITY_LABEL[key]()}
              value={booleanAt(value, 'capabilities', key)}
              inherited={booleanAt(inheritedRecord, 'capabilities', key)}
              onValueChange={(next) => onChange(withNested(value, 'capabilities', key, next))}
            />
          ))}
        </div>
      </ModelMetadataGroup>

      <ModelMetadataGroup titleId="metadata-cost-title" title={m['dashboard.routing.editor.metadata_group_costs']()}>
        <div className="space-y-2">
          {PRICE_MAIN_KEYS.map(priceRow)}
          <ModelMetadataMorePrices
            defaultOpen={PRICE_MORE_KEYS.some((key) => numberAt(value, 'cost', key) !== undefined)}
          >
            {PRICE_MORE_KEYS.map(priceRow)}
          </ModelMetadataMorePrices>
        </div>
        <div className="space-y-2 pt-1" data-testid="override-row-metadata-cost-tiers">
          <div className="grid grid-cols-[6rem_auto_minmax(0,1fr)] items-center gap-2.5">
            <span className="text-sm text-muted-foreground">{m['dashboard.routing.profile.tiers']()}</span>
            <Switch
              size="sm"
              checked={tiersOverridden}
              disabled={referencePending}
              aria-label={m['dashboard.routing.profile.override_field']({
                field: m['dashboard.routing.profile.tiers'](),
              })}
              // Tiers replace wholesale on merge, so an override starts as a copy of the reference.
              onCheckedChange={(on) =>
                onChange(withNested(value, 'cost', 'tiers', on ? [...referenceTiers] : undefined))
              }
            />
            <span className="text-xs text-muted-foreground">
              {tiersOverridden
                ? m['dashboard.routing.profile.tiers_overridden']()
                : m['dashboard.routing.profile.tiers_follow']()}
            </span>
          </div>
          <ModelMetadataTiers
            idPrefix="metadata-cost"
            tiers={ownTiers ?? referenceTiers}
            editable={tiersOverridden}
            onChange={(next) => onChange(withKey(value, 'cost', { ...objectAt(value, 'cost'), tiers: next }))}
          />
        </div>
      </ModelMetadataGroup>
    </div>
  );
};
