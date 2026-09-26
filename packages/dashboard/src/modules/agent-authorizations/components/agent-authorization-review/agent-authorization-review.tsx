import { m } from '@aio-proxy/i18n';
import type { AgentAuthorizationDetails } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { CardContent, CardFooter } from '@aio-proxy/ui/components/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@aio-proxy/ui/components/empty';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '@aio-proxy/ui/components/item';
import { CircleCheckIcon, CircleXIcon, Clock, Fingerprint, List, Sparkles, Tag, User } from 'lucide-react';
import { Fragment } from 'react';

import { useAgentAuthorization } from '../../hooks/use-agent-authorization';
import { AgentAuthorizationRequestError } from '../../services/agent-authorizations-service';
import { AgentAuthorizationCard } from '../card';

const terminalMessage = (status: 'approved' | 'denied' | 'expired' | 'consumed'): string => {
  if (status === 'approved') return m['dashboard.agent_authorization.approved']();
  if (status === 'denied') return m['dashboard.agent_authorization.denied']();
  if (status === 'expired') return m['dashboard.agent_authorization.expired']();
  return m['dashboard.agent_authorization.consumed']();
};

const requestErrorMessage = (error: unknown): string =>
  typeof AgentAuthorizationRequestError === 'function' &&
  error instanceof AgentAuthorizationRequestError &&
  error.code === 'authorization_unavailable'
    ? m['dashboard.agent_authorization.password_required']()
    : m['dashboard.agent_authorization.network_error']();

interface AgentAuthorizationReviewProps {
  readonly details: AgentAuthorizationDetails;
}

export const AgentAuthorizationReview: React.FC<AgentAuthorizationReviewProps> = ({ details }) => {
  const { approve, deny } = useAgentAuthorization();
  const decision = approve.data ?? deny.data;
  const terminal = decision ?? (details.status === 'pending' ? undefined : details);
  const pending = terminal === undefined && details.status === 'pending' ? details : undefined;
  const error = approve.error ?? deny.error;
  const rows =
    pending === undefined
      ? []
      : [
          { icon: User, label: m['dashboard.agent_authorization.target'](), value: pending.target },
          {
            icon: Fingerprint,
            label: m['dashboard.agent_authorization.installation'](),
            value: pending.installationId,
          },
          { icon: Tag, label: m['dashboard.agent_authorization.version'](), value: pending.adapterVersion },
          {
            icon: Clock,
            label: m['dashboard.agent_authorization.expires'](),
            value: new Date(pending.expiresAt).toLocaleString(),
          },
          { icon: List, label: m['dashboard.agent_authorization.permission_catalog']() },
          { icon: Sparkles, label: m['dashboard.agent_authorization.permission_inference']() },
        ];

  return (
    <AgentAuthorizationCard description={pending === undefined ? null : m['dashboard.agent_authorization.pending']()}>
      {pending === undefined ? null : (
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
      )}
      {pending === undefined ? null : (
        <CardFooter className="justify-end gap-2">
          <Button
            variant="outline"
            disabled={approve.isPending || deny.isPending}
            onClick={() => deny.mutate(pending.deviceId)}
          >
            {m['dashboard.agent_authorization.deny']()}
          </Button>
          <Button disabled={approve.isPending || deny.isPending} onClick={() => approve.mutate(pending.deviceId)}>
            {m['dashboard.agent_authorization.approve']()}
          </Button>
        </CardFooter>
      )}
      {terminal === undefined ? null : (
        <CardContent>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {terminal.status === 'approved' ? <CircleCheckIcon /> : <CircleXIcon />}
              </EmptyMedia>
              <EmptyDescription role="status">{terminalMessage(terminal.status)}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      )}
      {error === null || error === undefined ? null : (
        <CardContent>
          <p role="alert" className="text-sm text-destructive">
            {requestErrorMessage(error)}
          </p>
        </CardContent>
      )}
    </AgentAuthorizationCard>
  );
};
