import { m } from '@aio-proxy/i18n';
import { Input } from '@aio-proxy/ui/components/input';

export interface SyncPreviewRenameFieldProps {
  readonly value: string;
  readonly missing: boolean;
  onValueChange(value: string): void;
}

/** Shown only for an identity collision, where two objects claim one Provider ID. */
export const SyncPreviewRenameField: React.FC<SyncPreviewRenameFieldProps> = ({ value, missing, onValueChange }) => (
  <>
    <Input
      className="mt-3"
      aria-label={m['dashboard.sync.rename_provider']()}
      placeholder={m['dashboard.sync.rename_provider']()}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    />
    {missing ? (
      <p role="alert" className="mt-1 text-xs text-destructive">
        {m['dashboard.sync.rename_provider_required']()}
      </p>
    ) : null}
  </>
);
