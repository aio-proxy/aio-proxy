import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthCapability } from '@aio-proxy/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@aio-proxy/ui/components/alert-dialog';
import { Button } from '@aio-proxy/ui/components/button';
import { useState } from 'react';

import { resolveDashboardText } from '@/lib/localized-text';

interface OAuthLocalSignInButtonProps {
  readonly source: NonNullable<DashboardOAuthCapability['localSignIn']>['source'];
  readonly disabled: boolean;
  readonly onConfirm: () => void;
}

export const OAuthLocalSignInButton: React.FC<OAuthLocalSignInButtonProps> = ({ source, disabled, onConfirm }) => {
  const [isOpen, setIsOpen] = useState(false);
  const text = { source: resolveDashboardText(source) };

  return (
    <AlertDialog open={isOpen} onOpenChange={setIsOpen}>
      <AlertDialogTrigger
        render={<Button type="button" variant="outline" size="sm" />}
        data-testid="connection-local-sign-in"
        disabled={disabled}
      >
        {m['dashboard.providers.oauth.use_local_sign_in'](text)}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m['dashboard.providers.oauth.local_sign_in_confirm_title'](text)}</AlertDialogTitle>
          <AlertDialogDescription>
            {m['dashboard.providers.oauth.local_sign_in_confirm_description'](text)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m['common.cancel']()}</AlertDialogCancel>
          <AlertDialogAction
            type="button"
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              setIsOpen(false);
              onConfirm();
            }}
          >
            {m['dashboard.providers.oauth.use_local_sign_in'](text)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
