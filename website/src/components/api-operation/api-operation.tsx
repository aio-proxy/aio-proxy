/// <reference path="../../../theme/env.d.ts" />

import { BrowserOnly, useDark } from '@rspress/core/runtime';
import { Component, type ReactNode } from 'react';

import './api-operation.css';
import type { ApiOperationSlug } from './fixtures';

type ApiOperationProps = {
  readonly slug: ApiOperationSlug;
  readonly locale: 'en';
};

class ApiOperationErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) return <p role="alert">The API reference could not be loaded.</p>;
    return this.props.children;
  }
}

// oxlint-disable-next-line react/no-multi-comp -- The boundary is intentionally local to this dynamic region.
export function ApiOperation({ slug }: ApiOperationProps) {
  const dark = useDark();

  return (
    <ApiOperationErrorBoundary key={slug}>
      <BrowserOnly fallback={<p>Loading API reference…</p>}>
        {async () => {
          /* oxlint-disable react/todo -- BrowserOnly requires an async child so Scalar stays out of SSG. */
          const [{ ApiReferenceReact }, { ScalarFrame }] = await Promise.all([
            import('@scalar/api-reference-react'),
            import('./scalar-frame'),
          ]);
          await import('@scalar/api-reference-react/style.css');
          /* oxlint-enable react/todo */
          return <ScalarFrame ApiReference={ApiReferenceReact} dark={dark} slug={slug} />;
        }}
      </BrowserOnly>
    </ApiOperationErrorBoundary>
  );
}
