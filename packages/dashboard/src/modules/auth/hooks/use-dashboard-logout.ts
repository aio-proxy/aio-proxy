import { m } from "@aio-proxy/i18n";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { logoutDashboard } from "../services/auth-service";

export const useDashboardLogout = () =>
  useMutation({
    mutationFn: logoutDashboard,
    onError: () => toast.error(m["dashboard.auth.logout_failed"]()),
  });
