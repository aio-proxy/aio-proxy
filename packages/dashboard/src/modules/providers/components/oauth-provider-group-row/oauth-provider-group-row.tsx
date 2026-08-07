import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import { TableCell, TableRow } from '@aio-proxy/ui/components/table';
import type { Row } from '@tanstack/react-table';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type React from 'react';

import type { DataTableFeatures } from '@/hooks/use-data-table';

import { PROVIDER_KIND_LABEL } from '../../lib/constants';
import type { ProviderTableRow } from '../providers-table/provider-table-row';

interface OAuthProviderGroupRowProps {
  readonly row: Row<DataTableFeatures, ProviderTableRow>;
  readonly columnCount: number;
}

export const OAuthProviderGroupRow: React.FC<OAuthProviderGroupRowProps> = ({ row, columnCount }) => {
  if (row.original.rowType !== 'oauth-group') return null;

  const expanded = row.getIsExpanded();
  return (
    <TableRow data-testid={`provider-group-${row.original.groupKey}`}>
      <TableCell colSpan={columnCount}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start"
          aria-expanded={expanded}
          onClick={() => row.toggleExpanded()}
        >
          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          <span className="font-medium">{row.original.groupKey}</span>
          <Badge variant="outline">{PROVIDER_KIND_LABEL.oauth}</Badge>
        </Button>
      </TableCell>
    </TableRow>
  );
};
