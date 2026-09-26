import { AioProxyLogo } from '@aio-proxy/brand';
import { m } from '@aio-proxy/i18n';
import { CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';

export const AgentAuthorizationCodeHeader: React.FC = () => (
  <CardHeader className="text-center">
    <CardTitle>
      <h1 className="flex items-center justify-center gap-2 text-xl font-semibold">
        {m['dashboard.agent_authorization.title']()}
        <AioProxyLogo className="text-xl" />
      </h1>
    </CardTitle>
    <CardDescription>{m['dashboard.agent_authorization.instructions']()}</CardDescription>
  </CardHeader>
);
