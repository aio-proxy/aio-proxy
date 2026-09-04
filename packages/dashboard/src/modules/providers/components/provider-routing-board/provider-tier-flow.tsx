import { ArrowDown } from 'lucide-react';
import type React from 'react';

export const ProviderTierFlow: React.FC = () => (
  <div className="flex h-7 items-center justify-center text-muted-foreground/70" aria-hidden="true">
    <ArrowDown className="size-4" strokeWidth={1.75} />
  </div>
);
