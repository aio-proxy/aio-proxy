import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aio-proxy/ui/components/table';

import type { useRoutingMetadataForm } from '../../hooks/use-routing-metadata-form';
import { RoutingProviderOverrideFields } from '../routing-provider-override-fields';

export interface RoutingModelCostTabProps {
  readonly metadataForm: ReturnType<typeof useRoutingMetadataForm>;
  readonly providers: readonly DashboardRoutingProvider[];
  readonly writable: boolean;
}

export const RoutingModelCostTab: React.FC<RoutingModelCostTabProps> = ({ metadataForm, providers, writable }) => (
  <section className="space-y-2" data-testid="routing-overrides-section">
    <h3 className="text-sm font-medium">{m['dashboard.routing.editor.provider_overrides']()}</h3>
    <metadataForm.Field name="overrides">
      {(field) => (
        <fieldset disabled={!writable}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m['dashboard.routing.editor.provider_overrides']()}</TableHead>
                <TableHead>{m['dashboard.routing.editor.provider_cost_overrides']()}</TableHead>
                <TableHead>{m['dashboard.routing.editor.provider_limit_overrides']()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell colSpan={3} className="p-0">
                    <RoutingProviderOverrideFields
                      providerId={provider.id}
                      value={
                        field.state.value[provider.id] ?? {
                          cost: { touched: false, value: undefined },
                          limit: { touched: false, value: undefined },
                        }
                      }
                      onChange={(next) => field.handleChange({ ...field.state.value, [provider.id]: next })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </fieldset>
      )}
    </metadataForm.Field>
  </section>
);
