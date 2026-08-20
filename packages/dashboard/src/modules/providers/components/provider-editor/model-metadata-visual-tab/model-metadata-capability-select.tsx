import { m } from '@aio-proxy/i18n';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';

type CapabilityChoice = 'inherit' | 'true' | 'false';

interface ModelMetadataCapabilitySelectProps {
  /** Key inside `capabilities`. */
  readonly capability: string;
  readonly label: string;
  readonly value: boolean | undefined;
  readonly onValueChange: (next: boolean | undefined) => void;
}

const CHOICE_LABEL: Readonly<Record<CapabilityChoice, () => string>> = {
  inherit: m['dashboard.providers.editor.metadata_capability_inherit'],
  true: m['dashboard.providers.editor.metadata_capability_supported'],
  false: m['dashboard.providers.editor.metadata_capability_unsupported'],
};

/**
 * Three-state capability override. `capabilities.x` has three meanings, not two: absent inherits from
 * the catalog, `true` asserts support, `false` denies it. A switch collapses the last two into one
 * position, so an explicit deny reads as inherit and the next toggle silently discards it.
 */
export const ModelMetadataCapabilitySelect: React.FC<ModelMetadataCapabilitySelectProps> = ({
  capability,
  label,
  value,
  onValueChange,
}) => {
  const fieldId = `metadata-capabilities-${capability}`;
  const selected: CapabilityChoice = value === undefined ? 'inherit' : value ? 'true' : 'false';

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-3">
      <Label htmlFor={fieldId}>{label}</Label>
      <Select
        value={selected}
        onValueChange={(next: CapabilityChoice | null) => {
          if (next === null) return;
          onValueChange(next === 'inherit' ? undefined : next === 'true');
        }}
      >
        <SelectTrigger id={fieldId} data-testid={`metadata-capability-${capability}`} className="w-full">
          {/* Formats from the value itself: the trigger must read correctly before the popup mounts. */}
          <SelectValue>{(next: CapabilityChoice | null) => (next === null ? '' : CHOICE_LABEL[next]())}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">{CHOICE_LABEL.inherit()}</SelectItem>
          <SelectItem value="true">{CHOICE_LABEL.true()}</SelectItem>
          <SelectItem value="false">{CHOICE_LABEL.false()}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
};
