import { m } from '@aio-proxy/i18n';
import { Badge } from '@aio-proxy/ui/components/badge';
import { TableCell, TableRow } from '@aio-proxy/ui/components/table';
import type React from 'react';

import { UNKNOWN_LAB } from '../lib/routing-rows';

interface RoutingLabGroupRowProps {
  readonly lab: string;
  readonly modelCount: number;
  readonly riskCount: number;
  readonly columnCount: number;
}

const labLabel = (lab: string): string => (lab === UNKNOWN_LAB ? m['dashboard.routing.lab.unknown']() : lab);

export const RoutingLabGroupRow: React.FC<RoutingLabGroupRowProps> = ({ lab, modelCount, riskCount, columnCount }) => (
  <TableRow className="bg-muted/50 hover:bg-muted/50" data-testid={`routing-lab-group-${lab}`}>
    <TableCell colSpan={columnCount} className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{labLabel(lab)}</span>
        <span className="text-sm text-muted-foreground">
          {m['dashboard.routing.lab.model_count']({ count: modelCount })}
        </span>
        {riskCount > 0 ? (
          <Badge variant="secondary">{m['dashboard.routing.lab.risk_count']({ count: riskCount })}</Badge>
        ) : null}
      </div>
    </TableCell>
  </TableRow>
);
