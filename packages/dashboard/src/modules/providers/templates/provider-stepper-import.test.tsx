import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type React from 'react';

import { ProviderFormMode } from '../constants';
import { ProviderFormPage } from './provider-form-page';

const mocks = rs.hoisted(() => ({
  navigate: rs.fn(),
  mutate: rs.fn(),
  testDraft: rs.fn(),
  changePackage: rs.fn(),
  commitPackage: rs.fn(),
}));

rs.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<React.AnchorHTMLAttributes<HTMLAnchorElement>>) => (
    <a href="#" {...props}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}));

rs.mock('../hooks/use-provider-mutations', () => ({
  useProviderCreate: () => ({ mutate: mocks.mutate, isPending: false }),
  useProviderUpdate: () => ({ mutate: mocks.mutate, isPending: false }),
  useProviderDelete: () => ({ mutate: mocks.mutate, isPending: false }),
}));

rs.mock('../hooks/use-provider-options-schema', () => ({
  useProviderOptionsSchema: () => ({
    phase: 'schema_unavailable',
    schemaResolution: 'unavailable',
    warnings: [],
    packageName: '@ai-sdk/openai-compatible',
    changePackage: mocks.changePackage,
    commitPackage: mocks.commitPackage,
    requestInstall: rs.fn(),
    confirmInstall: rs.fn(),
  }),
}));

rs.mock('../components/provider-options-editor', () => ({
  ProviderOptionsEditor: () => null,
}));

rs.mock('../components/provider-request-transforms/provider-request-transforms-editor', () => ({
  ProviderRequestTransformsEditor: () => null,
}));

rs.mock('../services/provider-draft', () => ({
  testProviderDraftModel: mocks.testDraft,
}));

const apiInitial = {
  kind: ProviderKind.Api,
  id: 'api-provider',
  name: 'API Provider',
  enabled: true,
  weight: 10,
  protocol: ProviderProtocol.OpenAICompatible,
  baseURL: 'https://api.example/v1',
  proxy: '****',
  headers: { Authorization: '****' },
  models: ['model-a', 'model-b'],
} as const;

describe('Provider editor workflow', () => {
  test('renders one centered API editor with four horizontal steps and structured headers', () => {
    render(
      <ProviderFormPage
        mode={ProviderFormMode.Edit}
        kind={ProviderKind.Api}
        initial={apiInitial}
        providerId="api-provider"
      />,
    );

    const stepper = screen.getByRole('tablist', {
      name: /^Edit Provider$|^编辑提供商$|^編輯提供者$|^プロバイダーを編集$|^공급자 편집$/u,
    });
    expect(stepper).toHaveAttribute('aria-orientation', 'horizontal');
    expect(
      screen.getByRole('navigation', {
        name: /^Edit Provider$|^编辑提供商$|^編輯提供者$|^プロバイダーを編集$|^공급자 편집$/u,
      }),
    ).toBeTruthy();
    expect(within(stepper).getAllByRole('tab')).toHaveLength(4);
    expect(within(stepper).getByRole('tab', { name: /^Connection$|^连接$|^連線$|^接続$|^연결$/u })).toBeTruthy();
    expect(within(stepper).getByRole('tab', { name: /^Models$|^模型$|^モデル$|^모델$/u })).toBeTruthy();
    expect(within(stepper).getByRole('tab', { name: /^Routing$|^路由$|^ルーティング$|^라우팅$/u })).toBeTruthy();
    expect(within(stepper).getByRole('tab', { name: /^Validate$|^验证$|^驗證$|^検証$|^검증$/u })).toBeTruthy();

    expect(screen.getByTestId('provider-editor')).toHaveClass('mx-auto', 'max-w-2xl');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('navigation', { name: /^Breadcrumbs$|^面包屑$|^パンくずリスト$|^브레드크럼$/u }),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/^Back$|^返回$|^戻る$|^뒤로$/u)).toBeNull();

    const headers = screen.getByTestId('provider-form-field-headers');
    expect(within(headers).getByLabelText(/^Key$|^键$|^鍵$|^キー$|^키$/u)).toHaveValue('Authorization');
    expect(within(headers).getByLabelText(/^Value$|^值$|^値$|^값$/u)).toHaveValue('****');
    expect(
      within(headers).getByRole('button', { name: /Add header|添加请求头|新增請求標頭|ヘッダーを追加|헤더 추가/u }),
    ).toBeTruthy();
  });

  test('uses non-submitting step tabs without double-advancing or persisting from Validate', async () => {
    mocks.mutate.mockClear();
    render(
      <ProviderFormPage
        mode={ProviderFormMode.Edit}
        kind={ProviderKind.Api}
        initial={apiInitial}
        providerId="api-provider"
      />,
    );

    const tabs = screen.getAllByRole('tab');
    for (const tab of tabs) expect(tab).toHaveAttribute('type', 'button');

    const validate = screen.getByRole('tab', { name: /^Validate$|^验证$|^驗證$|^検証$|^검증$/u });
    fireEvent.click(validate);

    await waitFor(() => expect(validate).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('tab', { name: /^Models$|^模型$|^モデル$|^모델$/u })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test('blocks forward navigation until only the current connection fields are valid', () => {
    render(
      <ProviderFormPage
        mode={ProviderFormMode.Create}
        kind={ProviderKind.Api}
        initial={{ enabled: true, weight: 0 }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /^Models$|^模型$|^モデル$|^모델$/u }));

    expect(screen.getByRole('tab', { name: /^Connection$|^连接$|^連線$|^接続$|^연결$/u })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/required fields|必填|必須|필수/u);
  });

  test('preserves redacted proxy presentation for API and AI SDK providers', () => {
    const { unmount } = render(
      <ProviderFormPage
        mode={ProviderFormMode.Edit}
        kind={ProviderKind.Api}
        initial={apiInitial}
        providerId="api-provider"
      />,
    );

    expect(within(screen.getByTestId('provider-form-field-proxy')).getByRole('combobox')).toHaveTextContent(
      /Configured|已配置|已設定|設定済み|구성됨/u,
    );

    unmount();
    render(
      <ProviderFormPage
        mode={ProviderFormMode.Edit}
        kind={ProviderKind.AiSdk}
        initial={{
          kind: ProviderKind.AiSdk,
          id: 'sdk-provider',
          enabled: true,
          packageName: '@ai-sdk/openai-compatible',
          proxy: '****',
          models: ['model-a'],
        }}
        providerId="sdk-provider"
      />,
    );

    expect(within(screen.getByTestId('provider-form-field-proxy')).getByRole('combobox')).toHaveTextContent(
      /Configured|已配置|已設定|設定済み|구성됨/u,
    );
  });

  test('renders an absent API or AI SDK proxy override as inherited when editing', () => {
    const { proxy: _apiProxy, ...apiWithoutProxy } = apiInitial;
    const { unmount } = render(
      <ProviderFormPage
        mode={ProviderFormMode.Edit}
        kind={ProviderKind.Api}
        initial={apiWithoutProxy}
        providerId="api-provider"
      />,
    );

    expect(within(screen.getByTestId('provider-form-field-proxy')).getByRole('combobox')).toHaveTextContent(
      /Inherit global proxy|继承全局代理|繼承全域代理|グローバルプロキシを継承|전역 프록시 상속/u,
    );

    unmount();
    render(
      <ProviderFormPage
        mode={ProviderFormMode.Edit}
        kind={ProviderKind.AiSdk}
        initial={{
          kind: ProviderKind.AiSdk,
          id: 'sdk-provider',
          enabled: true,
          packageName: '@ai-sdk/openai-compatible',
          models: ['model-a'],
        }}
        providerId="sdk-provider"
      />,
    );

    expect(within(screen.getByTestId('provider-form-field-proxy')).getByRole('combobox')).toHaveTextContent(
      /Inherit global proxy|继承全局代理|繼承全域代理|グローバルプロキシを継承|전역 프록시 상속/u,
    );
  });

  test('tests an enabled model without gating Save and omits the redacted proxy from the draft', async () => {
    mocks.testDraft.mockResolvedValue({
      ok: false,
      error: { code: 'test_request_failed', recoverable: true },
    });
    render(
      <ProviderFormPage
        mode={ProviderFormMode.Edit}
        kind={ProviderKind.Api}
        initial={apiInitial}
        providerId="api-provider"
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /^Validate$|^验证$|^驗證$|^検証$|^검증$/u }));
    expect(
      screen.getByRole('combobox', { name: /Model to test|测试模型|測試模型|テストするモデル|테스트할 모델/u }),
    ).toHaveTextContent('model-a');
    fireEvent.click(
      screen.getByRole('button', { name: /Test connection|测试连接|測試連線|接続をテスト|연결 테스트/u }),
    );

    await waitFor(() => expect(mocks.testDraft).toHaveBeenCalledTimes(1));
    const request = mocks.testDraft.mock.calls[0]?.[0];
    expect(request).toMatchObject({ model: 'model-a', persistedProviderId: 'api-provider' });
    expect(request.draft).not.toHaveProperty('proxy');
    expect(await screen.findByRole('status')).toHaveTextContent(/test failed|测试失败|測試失敗|失敗|실패/u);
    expect(screen.getByTestId('provider-save')).toBeEnabled();
  });
});
