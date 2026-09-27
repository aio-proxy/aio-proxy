import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@aio-proxy/ui/components/table';

import type { useRoutingMetadataForm } from '../../hooks/use-routing-metadata-form';
import {
  COST_FIELDS,
  COST_LABEL,
  LIMIT_FIELDS,
  LIMIT_LABEL,
  RoutingProviderOverrideRow,
} from '../routing-provider-override-row';

export interface RoutingModelCostTabProps {
  readonly metadataForm: ReturnType<typeof useRoutingMetadataForm>;
  readonly providers: readonly DashboardRoutingProvider[];
  readonly writable: boolean;
}

/**
 * Cost and limit overrides as a Provider × field grid.
 *
 * The grid is the point: one field reads down a column across every Provider, which a stack of
 * per-Provider blocks cannot show. Cost and limits share one row per Provider under a grouped
 * header, so a field name is written once instead of once per Provider.
 */
export const RoutingModelCostTab: React.FC<RoutingModelCostTabProps> = ({ metadataForm, providers, writable }) => (
  <section className="space-y-2" data-testid="routing-overrides-section">
    <h3 className="text-sm font-medium">{m['dashboard.routing.editor.provider_overrides']()}</h3>
    <metadataForm.Field name="overrides">
      {(field) => (
        <fieldset disabled={!writable}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead rowSpan={2} className="align-bottom">
                  {m['dashboard.traces.provider']()}
                </TableHead>
                <TableHead colSpan={COST_FIELDS.length} className="border-l text-center">
                  {m['dashboard.routing.editor.provider_cost_overrides']()}
                </TableHead>
                <TableHead colSpan={LIMIT_FIELDS.length} className="border-l text-center">
                  {m['dashboard.routing.editor.provider_limit_overrides']()}
                </TableHead>
              </TableRow>
              <TableRow>
                {COST_FIELDS.map((key, index) => (
                  <TableHead key={`cost-${key}`} className={index === 0 ? 'border-l' : undefined}>
                    {COST_LABEL[key]()}
                  </TableHead>
                ))}
                {LIMIT_FIELDS.map((key, index) => (
                  <TableHead key={`limit-${key}`} className={index === 0 ? 'border-l' : undefined}>
                    {LIMIT_LABEL[key]()}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((provider) => (
                <RoutingProviderOverrideRow
                  key={provider.id}
                  providerId={provider.id}
                  value={
                    field.state.value[provider.id] ?? {
                      cost: { touched: false, value: undefined },
                      limit: { touched: false, value: undefined },
                    }
                  }
                  onChange={(next) => field.handleChange({ ...field.state.value, [provider.id]: next })}
                />
              ))}
            </TableBody>
          </Table>
        </fieldset>
      )}
    </metadataForm.Field>
  </section>
);
