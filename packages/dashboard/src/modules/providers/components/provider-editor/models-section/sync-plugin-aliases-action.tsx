import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { RotateCwIcon } from 'lucide-react';

interface SyncPluginAliasesActionProps {
  readonly disabled: boolean;
  readonly onClick: () => void;
}

/**
 * No pending state and no spinner: the suggestions ride down with the edit view and the merge is a
 * local form write, so there is nothing to wait on. No disabled-reason title either — the button's
 * cva base carries `disabled:pointer-events-none`, so a native tooltip could never open on it, and
 * the sibling Add Alias control behind the same gate does not carry one.
 */
export const SyncPluginAliasesAction: React.FC<SyncPluginAliasesActionProps> = ({ disabled, onClick }) => (
  <Button
    type="button"
    variant="outline"
    size="sm"
    data-testid="provider-alias-sync-plugin"
    disabled={disabled}
    onClick={onClick}
  >
    <RotateCwIcon data-icon="inline-start" aria-hidden="true" />
    {m['dashboard.providers.form.sync_plugin_aliases']()}
  </Button>
);
