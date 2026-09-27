import { m } from '@aio-proxy/i18n';
import type { AgentsSnapshot } from '@aio-proxy/types';
import { Alert, AlertDescription, AlertTitle } from '@aio-proxy/ui/components/alert';
import { Link } from '@tanstack/react-router';
import { InfoIcon, KeyRoundIcon } from 'lucide-react';

interface LocalSetupBannerProps {
  readonly snapshot: Pick<AgentsSnapshot, 'localSetup' | 'deviceAuthorization'>;
}

const SETUP_NOTICE = {
  remote_request: {
    title: () => m['dashboard.agents.banner.remote_request_title'](),
    description: () => m['dashboard.agents.banner.remote_request'](),
  },
  unavailable: {
    title: () => m['dashboard.agents.banner.unavailable_title'](),
    description: () => m['dashboard.agents.banner.unavailable'](),
  },
} as const;

export const LocalSetupBanner: React.FC<LocalSetupBannerProps> = ({ snapshot }) => {
  const notice = snapshot.localSetup === 'available' ? undefined : SETUP_NOTICE[snapshot.localSetup];
  const passwordRequired = snapshot.deviceAuthorization === 'password_required';
  if (notice === undefined && !passwordRequired) return null;
  return (
    <div className="space-y-2" data-testid="agents-banner">
      {notice === undefined ? null : (
        <Alert>
          <InfoIcon />
          <AlertTitle>{notice.title()}</AlertTitle>
          <AlertDescription>{notice.description()}</AlertDescription>
        </Alert>
      )}
      {passwordRequired ? (
        <Alert variant="destructive">
          <KeyRoundIcon />
          <AlertTitle>{m['dashboard.agents.banner.password_required_title']()}</AlertTitle>
          <AlertDescription>
            <Link to="/settings">{m['dashboard.agents.banner.password_required']()}</Link>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
};
