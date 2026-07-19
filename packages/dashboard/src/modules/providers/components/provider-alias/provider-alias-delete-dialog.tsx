import type { FC } from "react";

import { m } from "@aio-proxy/i18n";

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

type Props = {
  readonly alias: string;
  readonly variants: number;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
};

export const ProviderAliasDeleteDialog: FC<Props> = ({ alias, variants, open, onOpenChange, onConfirm }) => (
  <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{m["dashboard.providers.form.delete_alias_dialog_title"]({ alias })}</AlertDialogTitle>
        <AlertDialogDescription>
          {m["dashboard.providers.form.delete_alias_dialog_description"]({ variants })}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{m["dashboard.providers.form.delete_alias_dialog_cancel"]()}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={onConfirm}>
          {m["dashboard.providers.form.delete_alias_dialog_confirm"]()}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
