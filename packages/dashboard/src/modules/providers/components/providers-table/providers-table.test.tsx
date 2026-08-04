import type { DashboardProviderSummary } from '@aio-proxy/types';
import { afterEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ProvidersTable } from '.';
import { providerStub } from '../../provider-fixtures';

const mocks = rs.hoisted(() => ({
  toggle: rs.fn(),
  delete: rs.fn(),
  writeText: rs.fn().mockResolvedValue(undefined),
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

afterEach(() => {
  mocks.toggle.mockReset();
  mocks.delete.mockReset();
  mocks.writeText.mockClear();
});

describe('providers table', () => {
  test('shows concrete Provider routing fields and owns its row controls', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
    render(
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
    );

    const row = within(screen.getByTestId('provider-row-openai-main'));
    expect(row.getByText('OpenAI Main')).toBeTruthy();
    expect(row.getByText('openai-main')).toBeTruthy();
    expect(row.getByText('API')).toBeTruthy();
    expect(row.getByText('openai-response').closest('[data-slot="badge"]')).toBeNull();
    expect(row.getByTestId('provider-models-count')).toHaveTextContent('2');
    expect(row.getByText('7')).toBeTruthy();

    fireEvent.click(row.getByRole('switch', { name: /Disable provider openai-main|停用提供商 openai-main/u }));
    expect(mocks.toggle).toHaveBeenCalledWith({ id: 'openai-main', enabled: false });

    fireEvent.click(row.getByRole('button', { name: /Open actions for provider openai-main|打开提供商 openai-main/u }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Copy Provider ID|复制提供商 ID/u }));
    expect(mocks.writeText).toHaveBeenCalledWith('openai-main');

    fireEvent.click(row.getByRole('button', { name: /Open actions for provider openai-main|打开提供商 openai-main/u }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Delete$|^删除$/u }));
    expect(await screen.findByTestId('delete-provider-dialog')).toBeTruthy();
  });

  test('shows an AI SDK package identity and no fabricated protocol', () => {
    render(
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
    expect(row.getByText('N/A')).toBeTruthy();
    expect(row.getByText('0')).toBeTruthy();
  });

  test('expands accounts under a virtual OAuth plugin capability row', () => {
    render(<ProvidersTable providers={[oauthProvider('copilot-one', 'One'), oauthProvider('copilot-two', 'Two')]} />);

    const group = within(screen.getByTestId('provider-group-@aio-proxy/plugin-github-copilot/default'));
    expect(group.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(group.queryByText('copilot-one')).toBeNull();
    expect(group.queryByRole('switch')).toBeNull();
    expect(group.queryByLabelText(/Open actions|操作菜单/u)).toBeNull();
    expect(screen.queryByTestId('provider-row-copilot-one')).toBeNull();

    fireEvent.click(group.getByRole('button'));

    expect(screen.getAllByRole('columnheader', { name: /Provider|提供商/u })).toHaveLength(1);
    for (const id of ['copilot-one', 'copilot-two']) {
      const account = within(screen.getByTestId(`provider-row-${id}`));
      expect(account.getByRole('switch')).toBeTruthy();
      expect(account.getByRole('button', { name: new RegExp(id, 'u') })).toBeTruthy();
    }
  });

  test('auto-expands and pages to a focused OAuth account', async () => {
    const providers = [
      ...Array.from({ length: 10 }, (_, index) => providerStub({ id: `api-${index}`, kind: 'api' })),
      oauthProvider('copilot-focused', 'Focused'),
    ];

    render(<ProvidersTable providers={providers} focusProviderId="copilot-focused" />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-row-copilot-focused')).toHaveAttribute('data-focused', 'true');
    });
    expect(
      within(screen.getByTestId('provider-group-@aio-proxy/plugin-github-copilot/default')).getByRole('button'),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('provider-row-api-0')).toBeNull();
  });

  test('expands an OAuth group when its child Provider ID matches the filter', () => {
    render(<ProvidersTable providers={[oauthProvider('copilot-one', 'One'), oauthProvider('copilot-two', 'Two')]} />);

    fireEvent.change(screen.getByRole('textbox', { name: /Filter providers|筛选提供商/u }), {
      target: { value: 'copilot-two' },
    });

    expect(screen.getByTestId('provider-row-copilot-two')).toBeTruthy();
  });

  test('distinguishes an unavailable Provider weight from an explicit zero', () => {
    render(
      <ProvidersTable
        providers={[
          providerStub({ id: 'weight-missing', kind: 'api', protocol: 'openai-response' }),
          providerStub({ id: 'weight-zero', kind: 'api', protocol: 'openai-response', weight: 0 }),
        ]}
      />,
    );

    expect(within(screen.getByTestId('provider-row-weight-missing')).getByText('N/A')).toBeTruthy();
    const zero = within(screen.getByTestId('provider-row-weight-zero'));
    expect(zero.getByText('0')).toBeTruthy();
    expect(zero.queryByText('N/A')).toBeNull();
  });

  test('sorts Provider rows and hides a selected column', async () => {
    render(
      <ProvidersTable
        providers={[
          providerStub({ id: 'zulu', kind: 'api', protocol: 'openai-response' }),
          providerStub({ id: 'alpha', kind: 'api', protocol: 'anthropic' }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Provider$|^提供商$/u }));
    expect(screen.getByRole('columnheader', { name: /^Provider$|^提供商$/u })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    expect(screen.getAllByTestId(/^provider-row-/u).map((row) => row.getAttribute('data-testid'))).toEqual([
      'provider-row-alpha',
      'provider-row-zulu',
    ]);

    fireEvent.click(screen.getByRole('button', { name: /Provider columns|提供商列/u }));
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /^Protocol$|^协议$/u }));
    expect(screen.queryByRole('columnheader', { name: /^Protocol$|^协议$/u })).toBeNull();
  });
});

describe('invalid provider row', () => {
  test('keeps invalid rows diagnostic and non-actionable', () => {
    render(
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
