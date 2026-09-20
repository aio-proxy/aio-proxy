import { m } from '@aio-proxy/i18n';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@aio-proxy/ui/components/input-group';
import { SearchIcon } from 'lucide-react';
import { useState } from 'react';

import { toSpanAttributeRows } from '../../lib/span-attribute-rows';
import type { TraceFilterPatch } from '../../lib/trace-search';
import { SpanAttributeRow } from './span-attribute-row';

interface SpanAttributeTableProps {
  readonly attributes: Readonly<Record<string, unknown>>;
  /** 这个 span 的值说的是整条调用链（root 或推理 span），而不是某一跳。 */
  readonly tracewide: boolean;
  readonly onFilter: (patch: TraceFilterPatch) => void;
}

export const SpanAttributeTable: React.FC<SpanAttributeTableProps> = ({ attributes, tracewide, onFilter }) => {
  const [query, setQuery] = useState('');
  const rows = toSpanAttributeRows(attributes, query, tracewide);
  const total = Object.keys(attributes).length;

  return (
    <div className="space-y-2" data-testid="span-attribute-table">
      <div className="flex items-center gap-2">
        <InputGroup className="flex-1">
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
        {/* 两个数字加一条斜线，没有可翻译的词：搜出几条 / 一共几条。 */}
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {rows.length} / {total}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">
          {m['dashboard.traces.attributes_empty']()}
        </p>
      ) : (
        <div className="grid max-h-80 gap-px overflow-auto rounded-md bg-border">
          {rows.map((row) => (
            <SpanAttributeRow key={row.key} row={row} onFilter={onFilter} />
          ))}
        </div>
      )}
    </div>
  );
};
