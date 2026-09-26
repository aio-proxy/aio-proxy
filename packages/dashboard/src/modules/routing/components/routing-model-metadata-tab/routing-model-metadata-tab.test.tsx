import type { DashboardRoutingCatalog, DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as renderComponent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { useRoutingMetadataForm } from '../../hooks/use-routing-metadata-form';
import { RoutingModelMetadataTab } from './routing-model-metadata-tab';

rs.mock('../../services/models-dev-service', () => ({
  modelsDevSlugsQueryOptions: () => ({
    queryKey: ['models-dev-slugs'],
    queryFn: async () => ({ slugs: ['openai/gpt-5'] }),
  }),
  modelsDevLookupQueryOptions: (id: string) => ({
    queryKey: ['models-dev-lookup', id],
    queryFn: async () => ({ slug: null, metadata: null }),
  }),
}));

rs.mock('@/components/json-editor/json-schema-registry', () => ({
  registerJsonSchema: () => () => undefined,
}));

rs.mock('@/components/json-editor/json-language-service', () => ({
  createJsonLanguageExtensions: () => [],
}));

rs.mock('@/components/code-editor', () => ({
  CodeEditor: ({
    id,
    onChange,
    value,
    invalid,
  }: {
    id?: string;
    onChange?: (next: string) => void;
    value: string;
    invalid?: boolean;
  }) => (
    <textarea
      id={id}
      value={value}
      aria-invalid={invalid ? 'true' : undefined}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
const render = (ui: React.ReactElement) => renderComponent(ui, { wrapper });

const routingNumber = (effective: number, authored?: number) => ({
  ...(authored === undefined ? {} : { authored }),
  effective,
  wasNormalized: authored !== undefined && authored !== effective,
});

const provider = (
  values: Partial<DashboardRoutingProvider> & Pick<DashboardRoutingProvider, 'id'>,
): DashboardRoutingProvider => ({
  kind: ProviderKind.Api,
  enabled: true,
  state: { status: 'ready' },
  defaults: { priority: routingNumber(0), weight: routingNumber(1) },
  effective: {
    priority: values.defaults?.priority.effective ?? 0,
    weight: values.defaults?.weight.effective ?? 1,
    prioritySource: values.override?.priority === undefined ? 'provider' : 'model',
    weightSource: values.override?.weight === undefined ? 'provider' : 'model',
    eligible:
      (values.enabled ?? true) && (values.override?.weight?.effective ?? values.defaults?.weight.effective ?? 1) > 0,
    share: null,
  },
  ...values,
});

const metadataModel = (): DashboardRoutingModel => ({
  modelId: 'openai/gpt-5',
  revision: 'rev-1',
  baselineProviderIds: ['primary'],
  providerCount: 1,
  eligibleProviderCount: 1,
  hasOverrides: false,
  tiers: [{ priority: 0, providers: [{ providerId: 'primary', weight: 1, share: 1 }] }],
  providers: [
    provider({
      id: 'primary',
      defaults: { priority: routingNumber(0), weight: routingNumber(1) },
      effective: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: true,
        share: 1,
      },
    }),
  ],
});

const MetadataHarness: React.FC<{
  readonly catalog?: DashboardRoutingCatalog;
  readonly setMetadataValid?: (valid: boolean) => void;
}> = ({ catalog, setMetadataValid }) => {
  const model = metadataModel();
  const metadataForm = useRoutingMetadataForm(model);
  return (
    <RoutingModelMetadataTab
      metadataForm={metadataForm}
      modelId={model.modelId}
      catalog={catalog}
      setMetadataValid={setMetadataValid ?? rs.fn()}
    />
  );
};

const renderMetadata = (
  options: {
    readonly catalog?: DashboardRoutingCatalog;
    readonly setMetadataValid?: (valid: boolean) => void;
  } = {},
) => render(<MetadataHarness catalog={options.catalog} setMetadataValid={options.setMetadataValid} />);

test('renders the models.dev catalog facts next to the authored override', () => {
  renderMetadata({ catalog: { lab: 'anthropic', releaseDate: '2026-08' } });

  expect(screen.getByText('anthropic')).toBeInTheDocument();
  expect(screen.getByText('2026-08')).toBeInTheDocument();
});

test('omits the comparison entirely when models.dev has nothing cached', () => {
  renderMetadata({ catalog: undefined });

  expect(screen.queryByText(/目录值|Catalog/u)).not.toBeInTheDocument();
});

test('reports an invalid JSON draft upward so the page can gate saving', () => {
  const setMetadataValid = rs.fn();
  renderMetadata({ catalog: undefined, setMetadataValid });

  expect(setMetadataValid).toHaveBeenCalled();
});
