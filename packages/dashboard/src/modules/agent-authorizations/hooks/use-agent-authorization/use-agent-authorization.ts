import { useMutation } from '@tanstack/react-query';

import { decideAgentAuthorization, resolveAgentAuthorization } from '../../services/agent-authorizations-service';

export const useAgentAuthorization = () => {
  const resolve = useMutation({ mutationFn: resolveAgentAuthorization });
  const approve = useMutation({ mutationFn: (deviceId: string) => decideAgentAuthorization(deviceId, 'approve') });
  const deny = useMutation({ mutationFn: (deviceId: string) => decideAgentAuthorization(deviceId, 'deny') });
  return {
    resolve,
    approve,
    deny,
    reset: () => {
      resolve.reset();
      approve.reset();
      deny.reset();
    },
  };
};
