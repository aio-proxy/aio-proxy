import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Spinner } from '@aio-proxy/ui/components/spinner';

interface ModelsCatalogActionProps {
  readonly pending: boolean;
  readonly loaded: boolean;
  readonly onClick: () => void;
}

export const ModelsCatalogAction: React.FC<ModelsCatalogActionProps> = ({ pending, loaded, onClick }) => (
  <Button
    type="button"
    variant="outline"
    size="sm"
    data-testid="models-catalog-load"
    disabled={pending}
    onClick={onClick}
  >
    {pending ? <Spinner data-icon="inline-start" /> : null}
    {loaded ? m['dashboard.providers.form.catalog_reload']() : m['dashboard.providers.form.catalog_load']()}
  </Button>
);
