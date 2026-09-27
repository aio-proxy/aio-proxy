import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingCatalog } from '@aio-proxy/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aio-proxy/ui/components/table';

import type { useRoutingMetadataForm } from '../../hooks/use-routing-metadata-form';
import { ModelMetadataEditor } from '../model-metadata-editor';

export interface RoutingModelMetadataTabProps {
  readonly metadataForm: ReturnType<typeof useRoutingMetadataForm>;
  readonly modelId: string;
  readonly catalog: DashboardRoutingCatalog | undefined;
  readonly setMetadataValid: (valid: boolean) => void;
}

export const RoutingModelMetadataTab: React.FC<RoutingModelMetadataTabProps> = ({
  metadataForm,
  modelId,
  catalog,
  setMetadataValid,
}) => {
  const inherit = m['dashboard.routing.editor.inherit']();

  return (
    <div className="space-y-4">
      {catalog === undefined ? null : (
        <metadataForm.Subscribe selector={(state) => state.values.metadata}>
          {(metadataDraft) => {
            const releaseDateOverride = metadataDraft.value?.capabilities?.releaseDate;
            const hasReleaseDateOverride = typeof releaseDateOverride === 'string';
            const overrideReleaseDate = hasReleaseDateOverride ? releaseDateOverride : inherit;

            return (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m['dashboard.routing.detail.catalog_column_field']()}</TableHead>
                    <TableHead>{m['dashboard.routing.detail.catalog_column_catalog']()}</TableHead>
                    <TableHead>{m['dashboard.routing.detail.catalog_column_override']()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>{m['dashboard.routing.detail.catalog_field_lab']()}</TableCell>
                    <TableCell>{catalog.lab}</TableCell>
                    {/* No metadata field overrides the lab, so this column can only ever inherit. */}
                    <TableCell className="text-muted-foreground">{inherit}</TableCell>
                  </TableRow>
                  {catalog.releaseDate === undefined ? null : (
                    <TableRow>
                      <TableCell>{m['dashboard.routing.detail.catalog_field_release_date']()}</TableCell>
                      <TableCell>{catalog.releaseDate}</TableCell>
                      <TableCell className={hasReleaseDateOverride ? undefined : 'text-muted-foreground'}>
                        {overrideReleaseDate}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            );
          }}
        </metadataForm.Subscribe>
      )}
      <section className="space-y-2" data-testid="routing-metadata-section">
        <h3 className="text-sm font-medium">{m['dashboard.routing.editor.metadata']()}</h3>
        <p className="text-xs text-muted-foreground">{m['dashboard.routing.editor.metadata_description']()}</p>
        <metadataForm.Field name="metadata">
          {(field) => (
            <ModelMetadataEditor
              model={modelId}
              value={field.state.value.value}
              onChange={(next) => field.handleChange({ touched: true, value: next })}
              onValidityChange={setMetadataValid}
            />
          )}
        </metadataForm.Field>
      </section>
    </div>
  );
};
