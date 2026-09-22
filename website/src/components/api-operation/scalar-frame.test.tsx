/// <reference types="bun" />

import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { ScalarFrame } from './scalar-frame';

test('renders the operation document supplied for the current locale and slug', () => {
  const document = {
    openapi: '3.1.0',
    info: { title: '小部件 API', version: 'latest' },
    paths: { '/v1/widgets': { post: { operationId: 'createWidget', responses: {} } } },
  };
  const ApiReference = ({ configuration }: { configuration: { content: unknown } }) => (
    <output>{JSON.stringify(configuration.content)}</output>
  );

  const html = renderToStaticMarkup(
    <ScalarFrame
      ApiReference={ApiReference as never}
      dark={false}
      document={document as never}
      operationKey="zh:list-models"
    />,
  );

  expect(html).toContain('/v1/widgets');
  expect(html).not.toContain('/v1/models');
});
