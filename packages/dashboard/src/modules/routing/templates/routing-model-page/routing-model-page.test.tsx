import { expect, test } from '@rstest/core';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';

import { RoutingModelPage } from './routing-model-page';

const renderAt = (pathname: string) => {
  const rootRoute = createRootRoute();
  const splatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/routing/$',
    component: () => <RoutingModelPage modelId={splatRoute.useParams()._splat ?? ''} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([splatRoute]),
    history: createMemoryHistory({ initialEntries: [pathname] }),
  });
  render(<RouterProvider router={router} />);
};

test('resolves a model id that contains slashes', async () => {
  // The whole reason this route is a splat: real model ids look like this.
  renderAt('/routing/anthropic/claude-sonnet-4.5');

  expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('anthropic/claude-sonnet-4.5');
});

test('resolves a single-segment model id too', async () => {
  renderAt('/routing/gpt-5-codex');

  expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('gpt-5-codex');
});

test('resolves an id with more than two segments', async () => {
  // models.dev routes an OpenRouter model as openrouter/<vendor>/<model>; a proxied id can
  // carry the same shape, so the splat must not stop at the second slash.
  renderAt('/routing/openrouter/mistralai/mistral-large');

  expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('openrouter/mistralai/mistral-large');
});
