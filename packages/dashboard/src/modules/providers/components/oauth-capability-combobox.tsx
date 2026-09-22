import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthCapability } from '@aio-proxy/types';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@aio-proxy/ui/components/combobox';
import { Field } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';
import { useQuery } from '@tanstack/react-query';

import { PluginIcon } from '@/components/plugin-icon';
import { resolveDashboardText } from '@/lib/localized-text';

import { providerPluginPresentationsQueryOptions } from '../services/provider-plugin-labels';

interface OAuthCapabilityComboboxProps {
  readonly capabilities: readonly DashboardOAuthCapability[];
  readonly value: DashboardOAuthCapability | null;
  readonly onValueChange: (value: DashboardOAuthCapability | null) => void;
  readonly disabled?: boolean;
}

const capabilityLabel = (capability: DashboardOAuthCapability): string => resolveDashboardText(capability.displayName);

export const OAuthCapabilityCombobox: React.FC<OAuthCapabilityComboboxProps> = ({
  capabilities,
  value,
  onValueChange,
  disabled = false,
}) => {
  const plugins = useQuery(providerPluginPresentationsQueryOptions()).data?.plugins ?? [];
  const icons = new Map(plugins.map((plugin) => [plugin.packageName, plugin.icon]));
  return (
    <Field>
      <Label htmlFor="oauth-capability">{m['dashboard.providers.oauth.select_label']()}</Label>
      <Combobox
        items={capabilities}
        value={value}
        onValueChange={onValueChange}
        itemToStringLabel={capabilityLabel}
        itemToStringValue={capabilityLabel}
        disabled={disabled}
      >
        <ComboboxInput id="oauth-capability" placeholder={m['dashboard.providers.oauth.search_placeholder']()} />
        <ComboboxContent>
          <ComboboxEmpty>{m['dashboard.providers.oauth.empty']()}</ComboboxEmpty>
          <ComboboxList>
            {(capability: DashboardOAuthCapability) => {
              const icon = icons.get(capability.plugin);
              return (
                <ComboboxItem key={`${capability.plugin}:${capability.capability}`} value={capability}>
                  <div className="flex min-w-0 items-center gap-2">
                    {icon === undefined ? null : <PluginIcon icon={icon} size={16} className="shrink-0" />}
                    <div className="min-w-0">
                      <div>{capabilityLabel(capability)}</div>
                      {capability.description === undefined ? null : (
                        <div className="text-xs text-muted-foreground">
                          {resolveDashboardText(capability.description)}
                        </div>
                      )}
                    </div>
                  </div>
                </ComboboxItem>
              );
            }}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </Field>
  );
};
