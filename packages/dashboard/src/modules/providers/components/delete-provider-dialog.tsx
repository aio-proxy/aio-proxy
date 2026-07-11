import { m } from "@aio-proxy/i18n";
import type { DashboardProviderSummary } from "@aio-proxy/types";
import { forwardRef, useImperativeHandle, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useProviderDelete } from "../hooks/use-provider-mutations";

type DeleteProviderTarget = Pick<DashboardProviderSummary, "id">;

export type DeleteProviderDialogRef = {
  readonly open: (provider: DeleteProviderTarget) => void;
};

export const DeleteProviderDialog = forwardRef<DeleteProviderDialogRef>((_, ref) => {
  const [provider, setProvider] = useState<DeleteProviderTarget | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const { mutate: deleteProvider, isPending } = useProviderDelete();

  useImperativeHandle(
    ref,
    () => ({
      open: (nextProvider) => {
        setProvider(nextProvider);
        setIsOpen(true);
      },
    }),
    [],
  );

  const handleConfirm = () => {
    if (provider === null) return;

    deleteProvider(provider.id, {
      onSuccess: () => setIsOpen(false),
    });
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={setIsOpen}>
      {provider !== null && (
        <AlertDialogContent data-testid="delete-provider-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{m["dashboard.providers.delete_dialog.title"]()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m["dashboard.providers.delete_dialog.description"]({ id: provider.id })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m["dashboard.providers.delete_dialog.cancel"]()}</AlertDialogCancel>
            <AlertDialogAction data-testid="delete-confirm" onClick={handleConfirm} disabled={isPending}>
              {m["dashboard.providers.delete_dialog.confirm"]()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
});
