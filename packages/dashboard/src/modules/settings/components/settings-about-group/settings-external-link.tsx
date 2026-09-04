import { buttonVariants } from '@aio-proxy/ui/components/button';
import { SquareArrowOutUpRightIcon } from 'lucide-react';

interface SettingsExternalLinkProps {
  readonly href: string;
  readonly children: React.ReactNode;
}

// Styled with `buttonVariants` on a real anchor rather than rendered through `Button`: the
// Base UI button sets `role="button"` on whatever it renders, which would hide from assistive
// tech that these three rows navigate away. The rows still read as controls like the inputs above.
export const SettingsExternalLink: React.FC<SettingsExternalLinkProps> = ({ href, children }) => (
  <a className={buttonVariants({ variant: 'outline' })} href={href} target="_blank" rel="noreferrer">
    {children}
    <SquareArrowOutUpRightIcon data-icon="inline-end" />
  </a>
);
