import type { DashboardOAuthCapability } from "@aio-proxy/types";

import { getLocale, m } from "@aio-proxy/i18n";
import { resolveLocalizedText } from "@aio-proxy/plugin-sdk";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";

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
    <Label htmlFor="oauth-capability">{m["dashboard.providers.oauth.select_label"]()}</Label>
    <Combobox
      items={capabilities}
      value={value}
      onValueChange={onValueChange}
      itemToStringValue={(item) => resolveLocalizedText(item.label, getLocale())}
    >
      <ComboboxInput
        id="oauth-capability"
        aria-label={m["dashboard.providers.oauth.select_label"]()}
        placeholder={m["dashboard.providers.oauth.search_placeholder"]()}
      />
      <ComboboxContent>
        <ComboboxEmpty>{m["dashboard.providers.oauth.empty"]()}</ComboboxEmpty>
        <ComboboxList>
          {capabilities.map((capability) => (
            <ComboboxItem key={`${capability.plugin}:${capability.capability}`} value={capability}>
              <div>
                <div>{resolveLocalizedText(capability.label, getLocale())}</div>
                {capability.description === undefined ? null : (
                  <div className="text-xs text-muted-foreground">
                    {resolveLocalizedText(capability.description, getLocale())}
                  </div>
                )}
              </div>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  </Field>
);
