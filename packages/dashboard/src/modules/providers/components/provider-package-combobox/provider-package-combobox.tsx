import { m } from '@aio-proxy/i18n';
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@aio-proxy/ui/components/combobox';

// The AI SDK packages worth suggesting up front. npm package identifiers, so they stay literal and
// monospace rather than becoming messages. Any other compatible package can still be typed.
const COMMON_PROVIDER_PACKAGES = [
  '@ai-sdk/openai',
  '@ai-sdk/openai-compatible',
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/azure',
] as const;

interface ProviderPackageComboboxProps {
  readonly id: string;
  readonly value: string;
  /** Every keystroke. Resets the options-schema workflow without fetching anything. */
  readonly onValueChange: (value: string) => void;
  /** Blur or a list pick. Commits the package, which is what fetches its options schema. */
  readonly onCommit: (value: string) => void;
}

export const ProviderPackageCombobox: React.FC<ProviderPackageComboboxProps> = ({
  id,
  value,
  onValueChange,
  onCommit,
}) => {
  const typed = value.trim();
  const custom = typed !== '' && !COMMON_PROVIDER_PACKAGES.some((packageName) => packageName === typed) ? typed : null;
  const packages = custom === null ? COMMON_PROVIDER_PACKAGES : [...COMMON_PROVIDER_PACKAGES, custom];

  return (
    <Combobox
      items={packages}
      value={value === '' ? null : value}
      inputValue={value}
      autoHighlight
      onInputValueChange={onValueChange}
      onValueChange={(packageName: string | null) => {
        if (packageName === null) return;
        onValueChange(packageName);
        // A pick may never be followed by a blur, so it commits here instead of waiting for one.
        onCommit(packageName);
      }}
    >
      <ComboboxInput
        id={id}
        placeholder={m['dashboard.providers.form.placeholder_package_name']()}
        className="w-full [&_input]:font-mono"
        showClear
        clearLabel={m['common.clear']()}
        onBlur={() => onCommit(value)}
      />
      <ComboboxContent>
        <ComboboxList>
          {packages.map((packageName) => (
            <ComboboxItem key={packageName} value={packageName} className="font-mono text-xs">
              {packageName === custom ? m['dashboard.providers.form.package_use_custom']({ packageName }) : packageName}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
};
