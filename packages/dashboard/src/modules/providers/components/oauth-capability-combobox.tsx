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

import { resolveDashboardText } from '@/lib/localized-text';

interface OAuthCapabilityComboboxProps {
  readonly capabilities: readonly DashboardOAuthCapability[];
  readonly value: DashboardOAuthCapability | null;
  readonly onValueChange: (value: DashboardOAuthCapability | null) => void;
}

export const OAuthCapabilityCombobox: React.FC<OAuthCapabilityComboboxProps> = ({
  capabilities,
  value,
  onValueChange,
}) => (
  <Field>
    <Label htmlFor="oauth-capability">{m['dashboard.providers.oauth.select_label']()}</Label>
    <Combobox
      items={capabilities}
      value={value}
      onValueChange={onValueChange}
      itemToStringValue={(item) => resolveDashboardText(item.label)}
    >
      <ComboboxInput
        id="oauth-capability"
        aria-label={m['dashboard.providers.oauth.select_label']()}
        placeholder={m['dashboard.providers.oauth.search_placeholder']()}
      />
      <ComboboxContent>
        <ComboboxEmpty>{m['dashboard.providers.oauth.empty']()}</ComboboxEmpty>
        <ComboboxList>
          {capabilities.map((capability) => (
            <ComboboxItem key={`${capability.plugin}:${capability.capability}`} value={capability}>
              <div>
                <div>{resolveDashboardText(capability.label)}</div>
                {capability.description === undefined ? null : (
                  <div className="text-xs text-muted-foreground">{resolveDashboardText(capability.description)}</div>
                )}
              </div>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  </Field>
);
