import type React from 'react';

interface ProviderCardStatProps {
  readonly testId: string;
  readonly label: string;
  readonly value: string;
}

export const ProviderCardStat: React.FC<ProviderCardStatProps> = ({ testId, label, value }) => (
  <div className="min-w-0" data-testid={testId}>
    <div className="truncate text-xs text-muted-foreground">{label}</div>
    <div className="truncate text-sm font-medium tabular-nums">{value}</div>
  </div>
);
