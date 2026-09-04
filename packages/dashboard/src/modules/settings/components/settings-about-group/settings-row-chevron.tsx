import { ChevronRightIcon } from 'lucide-react';

// The whole row is the anchor on a navigation row, so this chevron is decoration: naming it
// would make assistive tech announce the destination twice, once for the title and once here.
export const SettingsRowChevron: React.FC = () => (
  <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
);
