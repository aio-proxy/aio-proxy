import { m } from '@aio-proxy/i18n';
import { toast } from '@aio-proxy/ui/components/toast';
import { useMutation } from '@tanstack/react-query';

import { logoutDashboard } from '../services/auth-service';

export const useDashboardLogout = () =>
  useMutation({
    mutationFn: logoutDashboard,
    onError: () => toast.add({ type: 'error', title: m['dashboard.auth.logout_failed']() }),
  });
