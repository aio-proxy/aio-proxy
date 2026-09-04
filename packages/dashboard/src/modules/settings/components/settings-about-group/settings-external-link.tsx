import { buttonVariants } from '@aio-proxy/ui/components/button';
import { ChevronRightIcon } from 'lucide-react';

interface SettingsExternalLinkProps {
  readonly href: string;
  readonly label: string;
}

// Styled with `buttonVariants` on a real anchor rather than rendered through `Button`: the
// Base UI button sets `role="button"` on whatever it renders, which would hide from assistive
// tech that these rows navigate away. The chevron is the only visible affordance, so the row's
// label has to come through `aria-label`.
export const SettingsExternalLink: React.FC<SettingsExternalLinkProps> = ({ href, label }) => (
  <a
    className={buttonVariants({ size: 'icon', variant: 'ghost' })}
    href={href}
    target="_blank"
    rel="noreferrer"
    aria-label={label}
  >
    <ChevronRightIcon />
  </a>
);
