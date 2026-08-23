import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@aio-proxy/ui/components/empty';
import { CircleCheckIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

export const OAUTH_COMPLETE_MESSAGE = 'aio-proxy:oauth-complete';
export const OAUTH_COMPLETE_CLOSE_DELAY_MS = 2000;

export const OAuthCompletePage: React.FC = () => {
  const [closeUnavailable, setCloseUnavailable] = useState(false);

  useEffect(() => {
    window.opener?.postMessage({ type: OAUTH_COMPLETE_MESSAGE }, window.location.origin);
    const timer = window.setTimeout(() => {
      window.close();
      setCloseUnavailable(!window.closed);
    }, OAUTH_COMPLETE_CLOSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleCheckIcon />
          </EmptyMedia>
          <EmptyTitle>
            <h1>{m['dashboard.oauth_complete.title']()}</h1>
          </EmptyTitle>
          <EmptyDescription>{m['dashboard.oauth_complete.description']()}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            type="button"
            onClick={() => {
              window.close();
              setCloseUnavailable(!window.closed);
            }}
          >
            {m['dashboard.oauth_complete.close']()}
          </Button>
          {closeUnavailable ? <p role="status">{m['dashboard.oauth_complete.close_unavailable']()}</p> : null}
        </EmptyContent>
      </Empty>
    </main>
  );
};
