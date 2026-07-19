import { m } from "@aio-proxy/i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  createProviderMutationFn,
  deleteProviderMutationFn,
  updateProviderMutationFn,
} from "../services/providers-service";

export function useProviderCreate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createProviderMutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.success(m["dashboard.providers.toast.created"]());
    },
    onError: () => {
      toast.error(m["dashboard.providers.toast.create_failed"]());
    },
  });
}

export function useProviderUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateProviderMutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.success(m["dashboard.providers.toast.updated"]());
    },
    onError: () => {
      toast.error(m["dashboard.providers.toast.update_failed"]());
    },
  });
}

export function useProviderDelete() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteProviderMutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.success(m["dashboard.providers.toast.deleted"]());
    },
    onError: () => {
      toast.error(m["dashboard.providers.toast.delete_failed"]());
    },
  });
}
