import { m } from '@aio-proxy/i18n';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@aio-proxy/ui/components/empty';
import { CircleCheckIcon, CircleXIcon } from 'lucide-react';

interface ResultProps {
  readonly status: 'approved' | 'denied' | 'expired' | 'consumed';
}

const message = (status: ResultProps['status']): string => {
  if (status === 'approved') return m['dashboard.agent_authorization.approved']();
  if (status === 'denied') return m['dashboard.agent_authorization.denied']();
  if (status === 'expired') return m['dashboard.agent_authorization.expired']();
  return m['dashboard.agent_authorization.consumed']();
};

export const Result: React.FC<ResultProps> = ({ status }) => (
  <div className="flex min-h-dvh items-center justify-center">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">{status === 'approved' ? <CircleCheckIcon /> : <CircleXIcon />}</EmptyMedia>
        <EmptyDescription role="status">{message(status)}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </div>
);
