import { m } from '@aio-proxy/i18n';
import { ToggleGroup, ToggleGroupItem } from '@aio-proxy/ui/components/toggle-group';

type CapabilityChoice = 'follow' | 'true' | 'false';

interface ModelMetadataCapabilityFieldProps {
  /** Key inside `capabilities`. */
  readonly capability: string;
  readonly label: string;
  readonly value: boolean | undefined;
  readonly onValueChange: (next: boolean | undefined) => void;
  /** The reference model's value, named on the "follow" choice so it reads without a lookup. */
  readonly inherited?: boolean | undefined;
}

// The chosen segment takes the primary tint, as every other "this is the value in effect" mark does.
const PRESSED = 'aria-pressed:bg-primary/10 aria-pressed:text-primary';

const choiceOf = (value: boolean | undefined): CapabilityChoice =>
  value === undefined ? 'follow' : value ? 'true' : 'false';

/**
 * Three-state capability override as a segmented control. "Follow" writes nothing; supported and
 * unsupported write an explicit boolean. A switch would collapse "unsupported" into "follow".
 */
export const ModelMetadataCapabilityField: React.FC<ModelMetadataCapabilityFieldProps> = ({
  capability,
  label,
  value,
  onValueChange,
  inherited,
}) => {
  const supported = m['dashboard.routing.editor.metadata_capability_supported']();
  const unsupported = m['dashboard.routing.editor.metadata_capability_unsupported']();
  const follow =
    inherited === undefined
      ? m['dashboard.routing.editor.metadata_capability_inherit']()
      : m['dashboard.routing.editor.metadata_capability_inherit_value']({ value: inherited ? supported : unsupported });

  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <ToggleGroup
        aria-label={label}
        data-testid={`metadata-capability-${capability}`}
        variant="outline"
        size="sm"
        spacing={0}
        value={[choiceOf(value)]}
        onValueChange={(next) => {
          // An empty array means the active option was pressed again, which is no change.
          const [choice] = next as CapabilityChoice[];
          if (choice === undefined) return;
          onValueChange(choice === 'follow' ? undefined : choice === 'true');
        }}
      >
        <ToggleGroupItem value="follow" className={PRESSED}>
          {follow}
        </ToggleGroupItem>
        <ToggleGroupItem value="true" className={PRESSED}>
          {supported}
        </ToggleGroupItem>
        <ToggleGroupItem value="false" className={PRESSED}>
          {unsupported}
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
};
