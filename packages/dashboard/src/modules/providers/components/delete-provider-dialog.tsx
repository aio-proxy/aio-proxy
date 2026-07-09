import { m } from "@aio-proxy/i18n";
import type { DashboardProviderSummary } from "@aio-proxy/types";
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

type Props = {
  provider: DashboardProviderSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const DeleteProviderDialog: React.FC<Props> = ({ provider, open, onOpenChange }) => {
  const { mutate: deleteProvider, isPending } = useProviderDelete();

  const handleConfirm = () => {
    deleteProvider(provider.id, {
      onSuccess: () => onOpenChange(false),
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="delete-provider-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{m["dashboard.providers.delete_dialog.title"]()}</AlertDialogTitle>
          <AlertDialogDescription>{m["dashboard.providers.delete_dialog.description"]()}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m["dashboard.providers.delete_dialog.cancel"]()}</AlertDialogCancel>
          <AlertDialogAction data-testid="delete-confirm" onClick={handleConfirm} disabled={isPending}>
            {m["dashboard.providers.delete_dialog.confirm"]()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
