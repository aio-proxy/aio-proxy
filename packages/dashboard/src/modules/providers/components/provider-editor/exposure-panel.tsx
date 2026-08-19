import { m } from '@aio-proxy/i18n';
import { type ProviderAlias, modelRoutes } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';

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
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{m['dashboard.providers.editor.exposure_title']()}</h2>
        {/* The disabled reason belongs here rather than after the list: read first, it explains why the
            names below are dimmed instead of contradicting a list that looked live. */}
        <p className="text-xs text-muted-foreground">
          {m['dashboard.providers.editor.exposure_description']()}
          {enabled ? null : ` ${m['dashboard.providers.editor.exposure_disabled_note']()}`}
        </p>
      </div>
      {warning === 'catalog_unavailable' ? (
        <p role="status" className="rounded-lg border bg-muted p-3 text-sm">
          {m['dashboard.providers.editor.exposure_warning_catalog']()}
        </p>
      ) : null}
      {routes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m['dashboard.providers.editor.exposure_empty']()}</p>
      ) : (
        <ul className={cn('space-y-1', enabled ? undefined : 'opacity-60')}>
          {routes.map((route) => {
            // Structural, not `alias !== modelId`: a name is an alias because it was configured as one,
            // and a direct row still has to say the name is the upstream's own id. `hasOwn`, not a
            // lookup, so a model literally named `constructor` is not mistaken for a configured alias.
            const isAlias = alias !== undefined && Object.hasOwn(alias, route.alias);
            return (
              <li
                key={route.alias}
                data-testid={`exposure-route-${route.alias}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2"
              >
                <code className="min-w-0 truncate text-xs">{route.alias}</code>
                <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                  {isAlias
                    ? m['dashboard.providers.editor.exposure_origin_alias']()
                    : m['dashboard.providers.editor.exposure_origin_model']()}
                </span>
                {isAlias ? (
                  <span className="col-span-2 truncate text-[0.6875rem] text-muted-foreground">
                    {`→ ${route.modelId}`}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
