import { m } from '@aio-proxy/i18n';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@aio-proxy/ui/components/input-group';
import { SearchIcon } from 'lucide-react';
import { useState } from 'react';

import { toSpanAttributeRows } from '../../lib/span-attribute-rows';
import type { TraceFilterPatch } from '../../lib/trace-search';
import { SpanAttributeRow } from './span-attribute-row';

interface SpanAttributeTableProps {
  readonly attributes: Readonly<Record<string, unknown>>;
  /** Root-span attributes describe the whole trace; an attempt span's describe one hop only. */
  readonly isRoot: boolean;
  readonly onFilter: (patch: TraceFilterPatch) => void;
}

export const SpanAttributeTable: React.FC<SpanAttributeTableProps> = ({ attributes, isRoot, onFilter }) => {
  const [query, setQuery] = useState('');
  const rows = toSpanAttributeRows(attributes, query, isRoot);

  return (
    <div className="space-y-2" data-testid="span-attribute-table">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          data-testid="span-attribute-search"
          aria-label={m['dashboard.traces.attributes_search_placeholder']()}
          placeholder={m['dashboard.traces.attributes_search_placeholder']()}
          onChange={(event) => setQuery(event.target.value)}
        />
      </InputGroup>
      {rows.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">
          {m['dashboard.traces.attributes_empty']()}
        </p>
      ) : (
        <div className="max-h-80 overflow-auto">
          {rows.map((row) => (
            <SpanAttributeRow key={row.key} row={row} onFilter={onFilter} />
          ))}
        </div>
      )}
    </div>
  );
};
