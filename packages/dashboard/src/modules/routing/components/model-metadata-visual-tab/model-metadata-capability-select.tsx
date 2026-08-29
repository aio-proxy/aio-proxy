import { m } from '@aio-proxy/i18n';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';

type CapabilityValue = 'true' | 'false';

interface ModelMetadataCapabilitySelectProps {
  /** Key inside `capabilities`. */
  readonly capability: string;
  readonly label: string;
  readonly value: boolean | undefined;
  readonly onValueChange: (next: boolean | undefined) => void;
  /** Catalog value shown on the inherit placeholder when `extend` has resolved metadata. */
  readonly inherited?: boolean | undefined;
}

const VALUE_LABEL: Readonly<Record<CapabilityValue, () => string>> = {
  true: m['dashboard.routing.editor.metadata_capability_supported'],
  false: m['dashboard.routing.editor.metadata_capability_unsupported'],
};

const inheritLabel = (inherited: boolean | undefined) =>
  inherited === undefined
    ? m['dashboard.routing.editor.metadata_capability_inherit']()
    : m['dashboard.routing.editor.metadata_capability_inherit_value']({
        value: inherited ? VALUE_LABEL.true() : VALUE_LABEL.false(),
      });

/**
 * Three-state capability override. `null` is inherit (placeholder styling); `true` / `false` write
 * an explicit boolean. A switch collapses deny into inherit and the next toggle silently discards it.
 */
export const ModelMetadataCapabilitySelect: React.FC<ModelMetadataCapabilitySelectProps> = ({
  capability,
  label,
  value,
  onValueChange,
  inherited,
}) => {
  const fieldId = `metadata-capabilities-${capability}`;
  const selected: CapabilityValue | null = value === undefined ? null : value ? 'true' : 'false';
  const inherit = inheritLabel(inherited);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_11rem] items-center gap-3">
      <Label htmlFor={fieldId}>{label}</Label>
      <Select
        value={selected}
        onValueChange={(next: CapabilityValue | null) => {
          if (next === null) onValueChange(undefined);
          else onValueChange(next === 'true');
        }}
      >
        <SelectTrigger id={fieldId} data-testid={`metadata-capability-${capability}`} className="w-full">
          {/* Explicit values format from the stored choice so the trigger is correct before the popup mounts. */}
          <SelectValue placeholder={inherit}>
            {(next: CapabilityValue | null) => (next === null ? inherit : VALUE_LABEL[next]())}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={null}>{inherit}</SelectItem>
          <SelectItem value="true">{VALUE_LABEL.true()}</SelectItem>
          <SelectItem value="false">{VALUE_LABEL.false()}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
};
