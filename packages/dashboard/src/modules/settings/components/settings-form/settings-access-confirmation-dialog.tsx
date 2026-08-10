import { m } from '@aio-proxy/i18n';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@aio-proxy/ui/components/alert-dialog';

interface SettingsAccessConfirmationDialogProps {
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export const SettingsAccessConfirmationDialog: React.FC<SettingsAccessConfirmationDialogProps> = ({
  open,
  onCancel,
  onConfirm,
}) => (
  <AlertDialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{m['dashboard.settings.confirmation_title']()}</AlertDialogTitle>
        <AlertDialogDescription>{m['dashboard.settings.confirmation_description']()}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel onClick={onCancel}>{m['dashboard.settings.cancel']()}</AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm}>{m['dashboard.settings.confirm']()}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
