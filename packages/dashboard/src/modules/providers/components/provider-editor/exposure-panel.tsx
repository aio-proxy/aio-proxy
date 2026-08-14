import { m } from '@aio-proxy/i18n';
import { type ProviderAlias, modelRoutes } from '@aio-proxy/types';

interface ExposurePanelProps {
  readonly models: readonly string[];
  readonly alias: ProviderAlias | undefined;
  readonly enabled: boolean;
  readonly warning?: 'catalog_unavailable' | undefined;
}

export const ExposurePanel: React.FC<ExposurePanelProps> = ({ models, alias, enabled, warning }) => {
  const routes = modelRoutes({ enabled: true, models, alias });

  return (
    <section className="space-y-3" data-testid="exposure-panel">
      <h2 className="text-base font-semibold">{m['dashboard.providers.editor.exposure_title']()}</h2>
      {warning === 'catalog_unavailable' ? (
        <p role="status" className="rounded-lg border bg-muted p-3 text-sm">
          {m['dashboard.providers.editor.exposure_warning_catalog']()}
        </p>
      ) : null}
      {routes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m['dashboard.providers.editor.exposure_empty']()}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {routes.map((route) => (
            <li key={route.alias} data-testid={`exposure-route-${route.alias}`}>
              <span>{route.alias}</span>
              {route.alias !== route.modelId ? (
                <>
                  <span>{` → ${route.modelId}`}</span>
                  <span className="text-muted-foreground">
                    {` ${m['dashboard.providers.editor.exposure_origin_alias']()}`}
                  </span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {enabled ? null : (
        <p className="text-sm text-muted-foreground">{m['dashboard.providers.editor.exposure_disabled_note']()}</p>
      )}
    </section>
  );
};
