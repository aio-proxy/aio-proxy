import { getLocale } from '@aio-proxy/i18n';

import '@aio-proxy/ui/styles.css';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import ReactDOM from 'react-dom/client';

import { routeTree } from './route-tree.gen';

document.documentElement.lang = getLocale();

const router = createRouter({
  routeTree,
  basepath: '/dashboard',
  defaultPreload: 'intent',
  scrollRestoration: true,
});

const rootEl = document.getElementById('root');
if (rootEl) {
  const root = ReactDOM.createRoot(rootEl);
  root.render(<RouterProvider router={router} />);
}

export { createDashboardClient } from './lib/dashboard-client';
