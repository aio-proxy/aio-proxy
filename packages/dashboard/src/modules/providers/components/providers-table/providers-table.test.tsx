import type { DashboardProviderSummary } from '@aio-proxy/types';
import { afterEach, describe, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';

import { ProvidersTable } from '.';
import { providerStub } from '../../lib/provider-fixtures';
import { providerPluginPresentationsQueryOptions } from '../../services/provider-plugin-labels';
import { providerUsageQueryOptions, type ProviderUsage } from '../../services/provider-usage-service';

const mocks = rs.hoisted(() => ({
  toggle: rs.fn(),
  delete: rs.fn(),
}));

rs.mock('@tanstack/react-router', () => ({ Link: 'a' }));
rs.mock('../../hooks/use-provider-enabled-mutation', () => ({
  useProviderEnabledMutation: () => ({ mutate: mocks.toggle, isPending: false }),
}));
rs.mock('../../hooks/use-provider-mutations', () => ({
  useProviderDelete: () => ({ mutate: mocks.delete, isPending: false }),
}));

const oauthProvider = (id: string, accountLabel: string): DashboardProviderSummary =>
  providerStub({
    id,
    name: accountLabel,
    kind: 'oauth',
    plugin: '@aio-proxy/plugin-github-copilot',
    capability: 'default',
    accountLabel,
    clientModels: ['gpt-5-mini'],
    weight: 2,
  });

const renderProvidersTable = (
  element: ReactElement,
  usage: ReadonlyMap<string, ProviderUsage> = new Map<string, ProviderUsage>(),
  plugins = [] as DashboardPluginSummary[],
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(providerUsageQueryOptions().queryKey, usage);
  queryClient.setQueryData(providerPluginPresentationsQueryOptions().queryKey, { plugins });
  return render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
};

afterEach(() => {
  mocks.toggle.mockReset();
  mocks.delete.mockReset();
});

describe('providers table', () => {
  test('shows concrete Provider routing fields and owns its row controls', async () => {
    renderProvidersTable(
      <ProvidersTable
        providers={[
          providerStub({
            id: 'openai-main',
            name: 'OpenAI Main',
            kind: 'api',
            protocol: 'openai-response',
            clientModels: ['gpt-5', 'gpt-5-mini'],
            weight: 7,
          }),
        ]}
      />,
      new Map([
        ['openai-main', { requestCount: 12_000n, totalTokens: 1_200_000n, estimatedCostNanoUsd: 2_500_000_000n }],
      ]),
    );

    const row = within(screen.getByTestId('provider-row-openai-main'));
    expect(screen.getAllByRole('columnheader')[0]).toBeEmptyDOMElement();
    expect(screen.getByRole('columnheader', { name: /24h requests|24 小时请求/u })).toBeInTheDocument();
    expect(row.getByText('OpenAI Main')).toBeTruthy();
    expect(row.getByText('openai-main')).toBeTruthy();
    expect(row.getByText('API')).toBeTruthy();
    expect(row.getByText('OpenAI Response')).toBeTruthy();
    expect(row.queryByText('API · openai-response')).toBeNull();
    expect(row.getByText('12K')).toBeTruthy();
    expect(row.queryByText('1.2M')).toBeNull();
    expect(row.queryByText('$2.50')).toBeNull();
    expect(row.getByTestId('provider-models-count')).toHaveTextContent('2');
    expect(row.getByText('7')).toBeTruthy();

    fireEvent.click(row.getByRole('switch', { name: /Disable provider openai-main|停用提供商 openai-main/u }));
    expect(mocks.toggle).toHaveBeenCalledWith({ id: 'openai-main', enabled: false });

    fireEvent.click(row.getByRole('button', { name: /Open actions for provider openai-main|打开提供商 openai-main/u }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Delete$|^删除$/u }));
    expect(await screen.findByTestId('delete-provider-dialog')).toBeTruthy();
  });

  test('shows an AI SDK package identity and no fabricated protocol', () => {
    renderProvidersTable(
      <ProvidersTable
        providers={[
          providerStub({
            id: 'anthropic-sdk',
            name: 'Anthropic SDK',
            kind: 'ai-sdk',
            packageName: '@ai-sdk/anthropic',
            weight: 0,
          }),
        ]}
      />,
    );

    const row = within(screen.getByTestId('provider-row-anthropic-sdk'));
    expect(row.getByText('@ai-sdk/anthropic')).toBeTruthy();
    expect(row.queryByText('N/A')).toBeNull();
  });

  test('expands accounts from the OAuth aggregate row and chevron with accessible keyboard controls', () => {
    const accounts = [
      oauthProvider('copilot-one', 'One'),
      { ...oauthProvider('copilot-two', 'Two'), clientModels: ['gpt-5-mini', 'gpt-5'] },
    ];
    renderProvidersTable(
      <ProvidersTable providers={accounts} />,
      new Map([
        ['copilot-one', { requestCount: 1_000n, totalTokens: 1_000_000n, estimatedCostNanoUsd: 1_250_000_000n }],
        ['copilot-two', { requestCount: 234n, totalTokens: 500_000n, estimatedCostNanoUsd: 2_750_000_000n }],
      ]),
      [
        {
          builtin: true,
          displayName: 'GitHub Copilot',
          enabled: true,
          hasOptions: false,
          icon: 'openai',
          packageName: '@aio-proxy/plugin-github-copilot',
          state: { status: 'ready' },
        },
      ],
    );

    const groupRow = screen.getByTestId('provider-group-@aio-proxy/plugin-github-copilot/default');
    const group = within(groupRow);
    expect(group.getByText('GitHub Copilot')).toBeTruthy();
    expect(group.queryByText('@aio-proxy/plugin-github-copilot/default')).toBeNull();
    const toggle = group.getByRole('button', { name: /Expand provider group|展开提供商分组/u });
    expect(toggle).toContainElement(screen.getByRole('img', { hidden: true }));
    expect(toggle.querySelector('svg')).not.toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(group.getByText('1.2K')).toBeTruthy();
    expect(group.queryByText('1.5M')).toBeNull();
    expect(group.queryByText('$4.00')).toBeNull();
    expect(group.getByTestId('provider-models-count')).toHaveTextContent('2');
    expect(group.queryByText('copilot-one')).toBeNull();
    expect(group.queryByRole('switch')).toBeNull();
    expect(group.queryByLabelText(/Open actions|操作菜单/u)).toBeNull();
    expect(screen.queryByTestId('provider-row-copilot-one')).toBeNull();

    fireEvent.click(groupRow);

    expect(screen.getByTestId('provider-row-copilot-one')).toBeTruthy();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(toggle, { key: 'Enter' });
    expect(screen.queryByTestId('provider-row-copilot-one')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    expect(screen.getAllByRole('columnheader', { name: /Provider|提供商/u })).toHaveLength(1);
    for (const id of ['copilot-one', 'copilot-two']) {
      const account = within(screen.getByTestId(`provider-row-${id}`));
      expect(account.getByRole('switch')).toBeTruthy();
      expect(account.getByRole('button', { name: new RegExp(id, 'u') })).toBeTruthy();
    }

    groupRow.focus();
    fireEvent.keyDown(groupRow, { key: ' ' });
    expect(screen.queryByTestId('provider-row-copilot-one')).toBeNull();
  });

  test('collapses an expanded OAuth group', async () => {
    renderProvidersTable(
      <ProvidersTable providers={[oauthProvider('copilot-one', 'One'), oauthProvider('copilot-two', 'Two')]} />,
    );

    const group = screen.getByTestId('provider-group-@aio-proxy/plugin-github-copilot/default');
    fireEvent.click(within(group).getByRole('button'));
    await waitFor(() => {
      expect(within(group).getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    });
    fireEvent.click(within(group).getByRole('button'));

    await waitFor(() => {
      expect(within(group).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    });
  });

  test('auto-expands and pages to a focused OAuth account', async () => {
    const providers = [
      ...Array.from({ length: 10 }, (_, index) => providerStub({ id: `api-${index}`, kind: 'api' })),
      oauthProvider('copilot-focused', 'Focused'),
    ];

    renderProvidersTable(<ProvidersTable providers={providers} focusProviderId="copilot-focused" />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-row-copilot-focused')).toHaveAttribute('data-focused', 'true');
    });
    expect(
      within(screen.getByTestId('provider-group-@aio-proxy/plugin-github-copilot/default')).getByRole('button'),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('provider-row-api-0')).toBeNull();
  });

  test('keeps a user-selected page after focusing a Provider', async () => {
    const providers = [
      ...Array.from({ length: 10 }, (_, index) => providerStub({ id: `api-${index}`, kind: 'api' })),
      oauthProvider('copilot-focused', 'Focused'),
    ];

    renderProvidersTable(<ProvidersTable providers={providers} focusProviderId="copilot-focused" />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-row-copilot-focused')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Previous|上一页/u }));

    await waitFor(() => {
      expect(screen.getByTestId('provider-row-api-0')).toBeTruthy();
    });
  });

  test('keeps a focused OAuth group collapsed after user interaction', async () => {
    const providers = [
      ...Array.from({ length: 10 }, (_, index) => providerStub({ id: `api-${index}`, kind: 'api' })),
      oauthProvider('copilot-focused', 'Focused'),
    ];

    renderProvidersTable(<ProvidersTable providers={providers} focusProviderId="copilot-focused" />);

    const group = screen.getByTestId('provider-group-@aio-proxy/plugin-github-copilot/default');
    await waitFor(() => {
      expect(within(group).getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    });
    fireEvent.click(within(group).getByRole('button'));

    await waitFor(() => {
      expect(within(group).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    });
  });

  test('renders an omitted Provider weight as its effective zero default', () => {
    renderProvidersTable(
      <ProvidersTable
        providers={[
          providerStub({ id: 'weight-missing', kind: 'api', protocol: 'openai-response' }),
          providerStub({ id: 'weight-zero', kind: 'api', protocol: 'openai-response', weight: 0 }),
        ]}
      />,
    );

    const missing = within(screen.getByTestId('provider-row-weight-missing'));
    const zero = within(screen.getByTestId('provider-row-weight-zero'));
    const weightColumnIndex = screen
      .getAllByRole('columnheader')
      .indexOf(screen.getByRole('columnheader', { name: /Weight|权重/u }));
    expect(missing.getAllByRole('cell')[weightColumnIndex]).toHaveTextContent('0');
    expect(zero.getAllByRole('cell')[weightColumnIndex]).toHaveTextContent('0');
  });

  test('sorts Providers by 24h request count without making descriptive columns sortable', () => {
    renderProvidersTable(
      <ProvidersTable
        providers={[
          providerStub({ id: 'zulu', kind: 'api', protocol: 'openai-response' }),
          providerStub({ id: 'alpha', kind: 'api', protocol: 'anthropic' }),
        ]}
      />,
      new Map([
        ['zulu', { requestCount: 1n, totalTokens: 0n, estimatedCostNanoUsd: 0n }],
        ['alpha', { requestCount: 2n, totalTokens: 0n, estimatedCostNanoUsd: 0n }],
      ]),
    );

    expect(screen.getByRole('columnheader', { name: /^Provider$|^提供商$/u })).not.toHaveAttribute('aria-sort');
    fireEvent.click(screen.getByRole('button', { name: /24h requests|24 小时请求/u }));
    expect(screen.getByTestId('provider-row-alpha')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^provider-row-/u).map((row) => row.getAttribute('data-testid'))).toEqual([
      'provider-row-alpha',
      'provider-row-zulu',
    ]);
    expect(screen.queryByRole('textbox', { name: /Filter providers|筛选提供商/u })).toBeNull();
    expect(screen.queryByRole('button', { name: /Provider columns|提供商列/u })).toBeNull();
  });
});

describe('invalid provider row', () => {
  test('keeps invalid rows diagnostic and non-actionable', () => {
    renderProvidersTable(
      <ProvidersTable
        providers={[
          providerStub({
            id: 'broken',
            kind: 'invalid',
            state: {
              status: 'unavailable',
              diagnostic: {
                code: 'PROVIDER_CONFIG_INVALID',
                summary: 'Invalid Provider configuration.',
                retryable: false,
                occurredAt: '2026-08-04T00:00:00.000Z',
              },
            },
          }),
        ]}
      />,
    );

    const row = within(screen.getByTestId('provider-row-broken'));
    const diagnostic = row.getByText('Invalid Provider configuration.');
    expect(diagnostic).toBeTruthy();
    expect(diagnostic.closest('td')).not.toHaveClass('hidden');
    expect(row.queryByRole('link')).toBeNull();
    expect(row.queryByRole('switch')).toBeNull();
    expect(row.queryByRole('button')).toBeNull();
  });
});
