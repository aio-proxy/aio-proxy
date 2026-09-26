import { m } from '@aio-proxy/i18n';
import type { AgentsSnapshot } from '@aio-proxy/types';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import { Link } from '@tanstack/react-router';

interface LocalSetupBannerProps {
  readonly snapshot: Pick<AgentsSnapshot, 'localSetup' | 'deviceAuthorization'>;
}

export const LocalSetupBanner: React.FC<LocalSetupBannerProps> = ({ snapshot }) => {
  const messages = [
    ...(snapshot.localSetup === 'remote_request' ? [m['dashboard.agents.banner.remote_request']()] : []),
    ...(snapshot.localSetup === 'unavailable' ? [m['dashboard.agents.banner.unavailable']()] : []),
  ];
  if (messages.length === 0 && snapshot.deviceAuthorization === 'available') return null;
  return (
    <Card size="sm" data-testid="agents-banner">
      <CardContent className="space-y-1 text-sm">
        {messages.map((message) => (
          <p key={message}>{message}</p>
        ))}
        {snapshot.deviceAuthorization === 'password_required' ? (
          <p role="alert" className="text-destructive">
            <Link to="/settings" className="underline underline-offset-4">
              {m['dashboard.agents.banner.password_required']()}
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
};
