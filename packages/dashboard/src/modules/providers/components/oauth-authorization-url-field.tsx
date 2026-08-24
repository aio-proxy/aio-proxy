import { m } from '@aio-proxy/i18n';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@aio-proxy/ui/components/input-group';
import { SquareArrowOutUpRightIcon } from 'lucide-react';

interface OAuthAuthorizationUrlFieldProps {
  readonly url: string;
}

export const OAuthAuthorizationUrlField: React.FC<OAuthAuthorizationUrlFieldProps> = ({ url }) => (
  <InputGroup className="w-full">
    <InputGroupInput readOnly value={url} aria-label={m['dashboard.providers.oauth.open_authorization']()} />
    <InputGroupAddon align="inline-end">
      <InputGroupButton
        size="icon-xs"
        nativeButton={false}
        aria-label={m['dashboard.providers.oauth.open_authorization_aria']()}
        render={<a href={url} target="_blank" rel="noreferrer" />}
      >
        <SquareArrowOutUpRightIcon />
      </InputGroupButton>
    </InputGroupAddon>
  </InputGroup>
);
