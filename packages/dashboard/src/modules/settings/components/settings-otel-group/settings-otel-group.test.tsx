import { m } from '@aio-proxy/i18n';
import type { DashboardSettingsView } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SettingsOtelGroup } from './settings-otel-group';

const view = (destinations: DashboardSettingsView['otel']['destinations']): DashboardSettingsView => ({
  apiKeys: [],
  hasPassword: false,
  host: '127.0.0.1',
  logging: { enabled: true, level: 'info', retentionDays: 3 },
  port: 9317,
  proxy: null,
  requireApiKey: false,
  retryAfterCapMs: 30_000,
  otel: { destinations },
});

const destination = {
  url: 'https://collector.example/v1/traces',
  contentType: 'protobuf' as const,
  headers: { Authorization: 'Bearer secret' },
};

const renderGroup = (destinations: DashboardSettingsView['otel']['destinations'], disabled = false) => {
  const onSave = rs.fn();
  const result = render(<SettingsOtelGroup disabled={disabled} settings={view(destinations)} onSave={onSave} />);
  return { onSave, ...result };
};

const add = () => m['dashboard.settings.otel_add']();
const addHeader = () => m['dashboard.settings.otel_add_header']();
const endpoint = () => m['dashboard.settings.otel_endpoint']();
const contentType = () => m['dashboard.settings.otel_content_type']();
const headerName = () => m['dashboard.settings.otel_header_name']();
const headerValue = () => m['dashboard.settings.otel_header_value']();

const pick = async (trigger: HTMLElement, option: string) => {
  fireEvent.click(trigger);
  const item = await screen.findByRole('option', { name: option });
  fireEvent.pointerDown(item, { pointerType: 'mouse' });
  fireEvent.click(item);
};

test('shows the description and add action without header values', () => {
  renderGroup([]);

  expect(screen.getByTestId('settings-group-otel')).toBeInTheDocument();
  expect(screen.getByText(m['dashboard.settings.otel_description']())).toBeInTheDocument();
  expect(screen.getByRole('button', { name: add() })).toBeEnabled();
  expect(screen.queryByDisplayValue('Bearer secret')).not.toBeInTheDocument();
});

test('rejects an empty endpoint without saving', async () => {
  const { onSave } = renderGroup([]);

  fireEvent.click(screen.getByRole('button', { name: add() }));
  fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_create']() }));

  await waitFor(() => {
    expect(screen.getByText(m['dashboard.settings.otel_endpoint_required']())).toBeInTheDocument();
  });
  expect(onSave).not.toHaveBeenCalled();
});

test('creates a protobuf destination and keeps the typed endpoint until the save succeeds', async () => {
  const { onSave } = renderGroup([]);

  fireEvent.click(screen.getByRole('button', { name: add() }));
  fireEvent.change(screen.getByLabelText(endpoint()), {
    target: { value: 'https://collector.example/v1/traces' },
  });
  await pick(screen.getByLabelText(contentType()), 'Protobuf');
  fireEvent.change(screen.getByLabelText(headerName()), { target: { value: 'Authorization' } });
  fireEvent.change(screen.getByLabelText(headerValue()), { target: { value: 'Bearer secret' } });
  fireEvent.click(screen.getByRole('button', { name: addHeader() }));
  fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_create']() }));

  await waitFor(() => {
    expect(onSave).toHaveBeenCalledTimes(1);
  });
  expect(onSave).toHaveBeenCalledWith(
    {
      otel: {
        destinations: [
          {
            url: 'https://collector.example/v1/traces',
            contentType: 'protobuf',
            headers: { Authorization: 'Bearer secret' },
          },
        ],
      },
    },
    { onSuccess: expect.any(Function) },
  );
  expect(screen.getByLabelText(endpoint())).toHaveValue('https://collector.example/v1/traces');

  const options = onSave.mock.calls[0]?.[1] as { readonly onSuccess: () => void };
  act(() => options.onSuccess());

  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

test('lists the endpoint and content type without header values', () => {
  renderGroup([
    { url: 'https://json.example/v1/traces', contentType: 'json', headers: { Authorization: 'Bearer secret' } },
    destination,
  ]);

  expect(screen.getByText('https://json.example/v1/traces')).toBeInTheDocument();
  expect(screen.getByText('https://collector.example/v1/traces')).toBeInTheDocument();
  expect(screen.getByText('JSON')).toBeInTheDocument();
  expect(screen.getByText('Protobuf')).toBeInTheDocument();
  expect(screen.queryByText('Bearer secret')).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue('Bearer secret')).not.toBeInTheDocument();
});

test('replaces the edited destination at the same index', async () => {
  const first = { url: 'https://a.example/v1/traces', contentType: 'json' as const, headers: {} };
  const { onSave } = renderGroup([first, destination]);

  fireEvent.click(screen.getAllByRole('button', { name: m['dashboard.settings.otel_edit']() })[1]!);
  fireEvent.change(screen.getByLabelText(endpoint()), {
    target: { value: 'https://other.example/v1/traces' },
  });
  fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_save']() }));

  await waitFor(() => {
    expect(onSave).toHaveBeenCalledTimes(1);
  });
  expect(onSave).toHaveBeenCalledWith(
    {
      otel: {
        destinations: [first, { ...destination, url: 'https://other.example/v1/traces' }],
      },
    },
    { onSuccess: expect.any(Function) },
  );
});

test('deletes a destination immediately', () => {
  const { onSave } = renderGroup([destination]);

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_delete']() }));

  expect(onSave).toHaveBeenCalledWith({ otel: { destinations: [] } });
});

test('disables add when eight destinations exist', () => {
  renderGroup(
    Array.from({ length: 8 }, (_, index) => ({
      url: `https://collector.example/${index}`,
      contentType: 'json' as const,
      headers: {},
    })),
  );

  expect(screen.getByRole('button', { name: add() })).toBeDisabled();
});

test('disables adding a header once sixteen rows exist', () => {
  renderGroup([]);

  fireEvent.click(screen.getByRole('button', { name: add() }));
  const addHeaderButton = screen.getByRole('button', { name: addHeader() });
  for (let index = 0; index < 15; index += 1) fireEvent.click(addHeaderButton);

  expect(screen.getAllByLabelText(headerName())).toHaveLength(16);
  expect(addHeaderButton).toBeDisabled();
});

test('blocks submit when a header has only a name', async () => {
  const { onSave } = renderGroup([]);

  fireEvent.click(screen.getByRole('button', { name: add() }));
  fireEvent.change(screen.getByLabelText(endpoint()), {
    target: { value: 'https://collector.example/v1/traces' },
  });
  fireEvent.change(screen.getByLabelText(headerName()), { target: { value: 'Authorization' } });
  fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_create']() }));

  await waitFor(() => {
    expect(screen.getByText(m['dashboard.settings.invalid']())).toBeInTheDocument();
  });
  expect(onSave).not.toHaveBeenCalled();
});

test('rejects duplicate header names without saving', async () => {
  const { onSave } = renderGroup([]);

  fireEvent.click(screen.getByRole('button', { name: add() }));
  fireEvent.change(screen.getByLabelText(endpoint()), {
    target: { value: 'https://collector.example/v1/traces' },
  });
  fireEvent.click(screen.getByRole('button', { name: addHeader() }));
  const names = screen.getAllByLabelText(headerName());
  const values = screen.getAllByLabelText(headerValue());
  fireEvent.change(names[0]!, { target: { value: 'Authorization' } });
  fireEvent.change(values[0]!, { target: { value: 'Bearer one' } });
  fireEvent.change(names[1]!, { target: { value: 'Authorization' } });
  fireEvent.change(values[1]!, { target: { value: 'Bearer two' } });
  fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_create']() }));

  await waitFor(() => {
    expect(screen.getByText(m['dashboard.settings.otel_header_duplicate']())).toBeInTheDocument();
  });
  expect(onSave).not.toHaveBeenCalled();
});

test('rejects header names that differ only by case without saving', async () => {
  const { onSave } = renderGroup([]);

  fireEvent.click(screen.getByRole('button', { name: add() }));
  fireEvent.change(screen.getByLabelText(endpoint()), {
    target: { value: 'https://collector.example/v1/traces' },
  });
  fireEvent.click(screen.getByRole('button', { name: addHeader() }));
  const names = screen.getAllByLabelText(headerName());
  const values = screen.getAllByLabelText(headerValue());
  fireEvent.change(names[0]!, { target: { value: 'Authorization' } });
  fireEvent.change(values[0]!, { target: { value: 'Bearer one' } });
  fireEvent.change(names[1]!, { target: { value: 'authorization' } });
  fireEvent.change(values[1]!, { target: { value: 'Bearer two' } });
  fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_create']() }));

  await waitFor(() => {
    expect(screen.getByText(m['dashboard.settings.otel_header_duplicate']())).toBeInTheDocument();
  });
  expect(onSave).not.toHaveBeenCalled();
});

test('blocks submit when a header has only a value', async () => {
  const { onSave } = renderGroup([]);

  fireEvent.click(screen.getByRole('button', { name: add() }));
  fireEvent.change(screen.getByLabelText(endpoint()), {
    target: { value: 'https://collector.example/v1/traces' },
  });
  fireEvent.change(screen.getByLabelText(headerValue()), { target: { value: 'Bearer secret' } });
  fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_create']() }));

  await waitFor(() => {
    expect(screen.getByText(m['dashboard.settings.invalid']())).toBeInTheDocument();
  });
  expect(onSave).not.toHaveBeenCalled();
});

test('shows header field labels only on the first row', () => {
  renderGroup([]);

  fireEvent.click(screen.getByRole('button', { name: add() }));
  fireEvent.click(screen.getByRole('button', { name: addHeader() }));

  expect(screen.getAllByText(headerName())).toHaveLength(1);
  expect(screen.getAllByText(headerValue())).toHaveLength(1);
  expect(screen.getAllByLabelText(headerName())).toHaveLength(2);
});

test('removes a header row', () => {
  renderGroup([]);

  fireEvent.click(screen.getByRole('button', { name: add() }));
  fireEvent.click(screen.getByRole('button', { name: addHeader() }));
  const names = screen.getAllByLabelText(headerName());
  fireEvent.change(names[0]!, { target: { value: 'Authorization' } });
  fireEvent.change(names[1]!, { target: { value: 'X-Tenant' } });
  fireEvent.click(
    screen.getAllByRole('button', {
      name: m['dashboard.settings.otel_remove_header']({
        name: m['dashboard.settings.otel_unnamed_header'](),
      }),
    })[0]!,
  );

  expect(screen.getAllByLabelText(headerName())).toHaveLength(1);
  expect(screen.getByLabelText(headerName())).toHaveValue('X-Tenant');
});

test('keeps the typed endpoint when the parent leaves the dialog open', async () => {
  const onSave = rs.fn();
  const settings = view([]);
  const { rerender } = render(<SettingsOtelGroup disabled={false} settings={settings} onSave={onSave} />);

  fireEvent.click(screen.getByRole('button', { name: add() }));
  fireEvent.change(screen.getByLabelText(endpoint()), {
    target: { value: 'https://collector.example/v1/traces' },
  });
  fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_create']() }));
  await waitFor(() => {
    expect(onSave).toHaveBeenCalledTimes(1);
  });
  rerender(<SettingsOtelGroup disabled settings={settings} onSave={onSave} />);

  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByLabelText(endpoint())).toHaveValue('https://collector.example/v1/traces');
});

for (const duplicate of [false, true]) {
  test(`closes a stale edit after a failed-save refresh (duplicate destinations: ${duplicate})`, async () => {
    const first = { ...destination, url: 'https://a.example/v1/traces' };
    const last = duplicate ? destination : { ...destination, url: 'https://c.example/v1/traces' };
    const { onSave, rerender } = renderGroup([first, destination, last]);
    fireEvent.click(screen.getAllByRole('button', { name: m['dashboard.settings.otel_edit']() })[1]!);
    fireEvent.change(screen.getByLabelText(endpoint()), { target: { value: 'ftp://invalid.example' } });
    fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_save']() }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    // Failed writes refetch settings without invoking onSuccess.
    rerender(<SettingsOtelGroup disabled={false} settings={view([destination, last])} onSave={onSave} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole('button', { name: m['dashboard.settings.otel_edit']() })[0]!);
    fireEvent.change(screen.getByLabelText(endpoint()), { target: { value: 'https://edited.example' } });
    fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_save']() }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0]).toEqual({
      otel: { destinations: [{ ...destination, url: 'https://edited.example' }, last] },
    });
  });
}

test('retains the edit draft on an unchanged failed-save refresh and allows retry', async () => {
  const { onSave, rerender } = renderGroup([destination, destination]);
  fireEvent.click(screen.getAllByRole('button', { name: m['dashboard.settings.otel_edit']() })[1]!);
  fireEvent.change(screen.getByLabelText(endpoint()), { target: { value: 'ftp://invalid.example' } });
  fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_save']() }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  rerender(
    <SettingsOtelGroup disabled={false} settings={view(structuredClone([destination, destination]))} onSave={onSave} />,
  );
  expect(screen.getByLabelText(endpoint())).toHaveValue('ftp://invalid.example');
  fireEvent.change(screen.getByLabelText(endpoint()), { target: { value: 'https://edited.example' } });
  fireEvent.click(screen.getByRole('button', { name: m['dashboard.settings.otel_save']() }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  expect(onSave.mock.calls[1]?.[0]).toEqual({
    otel: { destinations: [destination, { ...destination, url: 'https://edited.example' }] },
  });
});
