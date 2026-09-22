/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { ScalarFrame } from './scalar-frame';

type ScalarConfiguration = {
  readonly agent?: { readonly disabled?: boolean };
  readonly content: unknown;
  readonly defaultOpenAllTags?: boolean;
  readonly layout?: string;
  readonly onRequestBuilt?: (input: { readonly request: Request }) => void;
  readonly persistAuth?: boolean;
  readonly proxyUrl?: string;
  readonly servers?: readonly { readonly url: string }[];
  readonly showDeveloperTools?: string;
  readonly telemetry?: boolean;
};

let renderedConfiguration: ScalarConfiguration | undefined;

beforeEach(() => {
  renderedConfiguration = undefined;
});

function FakeApiReference({ configuration }: { readonly configuration: ScalarConfiguration }) {
  renderedConfiguration = configuration;
  return <output>{JSON.stringify(configuration.content)}</output>;
}

test('renders the operation document supplied for the current locale and slug', () => {
  const document = {
    openapi: '3.1.0',
    info: { title: '小部件 API', version: 'latest' },
    paths: { '/v1/widgets': { post: { operationId: 'createWidget', responses: {} } } },
  };
  const html = renderToStaticMarkup(
    <ScalarFrame
      ApiReference={FakeApiReference as never}
      dark={false}
      document={document as never}
      operationKey="zh:list-models"
    />,
  );

  expect(html).toContain('/v1/widgets');
  expect(html).not.toContain('/v1/models');
});

test('uses an explicit safe server and guards the exact outgoing request', () => {
  const html = renderToStaticMarkup(
    <ScalarFrame ApiReference={FakeApiReference as never} dark={false} document={{}} operationKey="en:list-models" />,
  );

  expect(html).toContain('<form');
  expect(html).toContain('type="url"');
  expect(html).toContain('value=""');
  expect(html).toContain('placeholder="http://127.0.0.1:9317"');
  expect(renderedConfiguration?.servers).toEqual([{ url: 'http://127.0.0.1:9317' }]);
  expect(renderedConfiguration?.proxyUrl).toBeUndefined();
  expect(renderedConfiguration?.showDeveloperTools).toBe('never');
  expect(renderedConfiguration?.agent).toEqual({ disabled: true });
  expect(renderedConfiguration?.persistAuth).toBe(false);
  expect(renderedConfiguration?.telemetry).toBe(false);
  expect(renderedConfiguration?.defaultOpenAllTags).toBe(true);
  expect(renderedConfiguration?.layout).toBe('modern');
  expect(() =>
    renderedConfiguration?.onRequestBuilt?.({ request: new Request('http://127.0.0.1:9317/v1/models') }),
  ).not.toThrow();
  expect(() =>
    renderedConfiguration?.onRequestBuilt?.({ request: new Request('https://aioproxy.dev/v1/models') }),
  ).toThrow('documentation origin');
});
