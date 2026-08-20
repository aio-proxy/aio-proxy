import { ProviderKind } from '@aio-proxy/types';
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';

import { ProviderFormMode } from '@/modules/providers/lib/constants';
import { ProviderEditorPage } from '@/modules/providers/templates/provider-editor-page';

const NewProviderPage: React.FC = () => {
  const { session } = useSearch({ from: '/providers/new' });
  const navigate = useNavigate({ from: '/providers/new' });
  const [kind, setKind] = useState<ProviderKind>(ProviderKind.Api);
  return (
    <ProviderEditorPage
      mode={ProviderFormMode.Create}
      kind={kind}
      onKindChange={setKind}
      initial={{ enabled: true, weight: 0 }}
      sessionId={session}
      onSessionIdChange={(next) =>
        void navigate({ search: next === undefined ? {} : { session: next }, replace: true })
      }
    />
  );
};

export const Route = createFileRoute('/providers/new')({
  validateSearch: (raw) => ({ session: typeof raw['session'] === 'string' ? raw['session'] : undefined }),
  component: NewProviderPage,
});
