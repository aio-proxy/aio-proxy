import { m } from '@aio-proxy/i18n';
import type { AgentAuthorizationDetails } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { CardContent, CardFooter } from '@aio-proxy/ui/components/card';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '@aio-proxy/ui/components/item';
import { Clock, Fingerprint, List, Sparkles, Tag, User } from 'lucide-react';
import { Fragment } from 'react';

import { useAgentAuthorization } from '../../hooks/use-agent-authorization';
import { AgentAuthorizationRequestError } from '../../services/agent-authorizations-service';
import { Card } from '../card';
import { Result } from '../result';

const requestErrorMessage = (error: unknown): string =>
  typeof AgentAuthorizationRequestError === 'function' &&
  error instanceof AgentAuthorizationRequestError &&
  error.code === 'authorization_unavailable'
    ? m['dashboard.agent_authorization.password_required']()
    : m['dashboard.agent_authorization.network_error']();

interface ReviewProps {
  readonly details: Extract<AgentAuthorizationDetails, { status: 'pending' }>;
}

export const Review: React.FC<ReviewProps> = ({ details }) => {
  const { approve, deny } = useAgentAuthorization();
  const terminal = approve.data ?? deny.data;
  const error = approve.error ?? deny.error;
  const rows = [
    { icon: User, label: m['dashboard.agent_authorization.target'](), value: details.target },
    {
      icon: Fingerprint,
      label: m['dashboard.agent_authorization.installation'](),
      value: details.installationId,
    },
    { icon: Tag, label: m['dashboard.agent_authorization.version'](), value: details.adapterVersion },
    {
      icon: Clock,
      label: m['dashboard.agent_authorization.expires'](),
      value: new Date(details.expiresAt).toLocaleString(),
    },
    { icon: List, label: m['dashboard.agent_authorization.permission_catalog']() },
    { icon: Sparkles, label: m['dashboard.agent_authorization.permission_inference']() },
  ];

  if (terminal !== undefined) return <Result status={terminal.status} />;

  return (
    <Card description={m['dashboard.agent_authorization.pending']()}>
      <CardContent>
        <section aria-label={m['dashboard.agent_authorization.permissions_title']()}>
          <ItemGroup className="gap-0">
            {rows.map((row, index) => {
              const Icon = row.icon;
              return (
                <Fragment key={row.label}>
                  <Item size="xs">
                    <ItemMedia variant="icon">
                      <Icon />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{row.label}</ItemTitle>
                    </ItemContent>
                    {row.value === undefined ? null : (
                      <ItemContent>
                        <ItemDescription>{row.value}</ItemDescription>
                      </ItemContent>
                    )}
                  </Item>
                  {index === rows.length - 1 ? null : <ItemSeparator className="my-0" />}
                </Fragment>
              );
            })}
          </ItemGroup>
        </section>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button
          variant="outline"
          disabled={approve.isPending || deny.isPending}
          onClick={() => deny.mutate(details.deviceId)}
        >
          {m['dashboard.agent_authorization.deny']()}
        </Button>
        <Button disabled={approve.isPending || deny.isPending} onClick={() => approve.mutate(details.deviceId)}>
          {m['dashboard.agent_authorization.approve']()}
        </Button>
      </CardFooter>
      {error === null || error === undefined ? null : (
        <CardContent>
          <p role="alert" className="text-sm text-destructive">
            {requestErrorMessage(error)}
          </p>
        </CardContent>
      )}
    </Card>
  );
};
