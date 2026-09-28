import { cn } from 'cn';
import { Activity } from 'lucide-react';

import { Panel } from './panel';
import { Section } from './section';
import { useHomeCopy } from './use-home-copy';

const requests = [
  {
    model: 'claude-sonnet-4-6',
    provider: 'claude-team',
    status: 200,
    latency: '1.8 s',
    tokens: '14.2k',
    cost: '$0.071',
  },
  { model: 'gpt-5', provider: 'chatgpt-pro', status: 200, latency: '2.4 s', tokens: '9.8k', cost: '$0.000' },
  {
    model: 'claude-sonnet-4-6',
    provider: 'anthropic-key',
    status: 200,
    latency: '0.9 s',
    tokens: '3.1k',
    cost: '$0.016',
  },
  { model: 'gemini-2.5-pro', provider: 'google', status: 200, latency: '1.2 s', tokens: '6.4k', cost: '$0.021' },
  { model: 'gpt-5-mini', provider: 'openrouter', status: 502, latency: '0.3 s', tokens: '—', cost: '—' },
] as const;

// Offsets and widths are percentages of the total trace duration.
const spans = [
  { label: 'inbound · anthropic', start: 0, width: 100, tone: 'bg-olive-400 dark:bg-olive-500' },
  { label: 'route · 3 candidates', start: 1, width: 3, tone: 'bg-teal-400' },
  { label: 'claude-team · 429', start: 4, width: 18, tone: 'bg-red-400' },
  { label: 'anthropic-key · stream', start: 23, width: 76, tone: 'bg-teal-600 dark:bg-teal-400' },
  { label: 'first token', start: 36, width: 1, tone: 'bg-amber-400' },
] as const;

// A hand-drawn 24-point request curve; keeps the mock free of a charting dependency.
const sparkline = [12, 18, 15, 22, 28, 24, 31, 38, 35, 42, 40, 48, 52, 47, 55, 61, 58, 66, 72, 69, 75, 80, 78, 88];

export function Observability() {
  const copy = useHomeCopy().observability;
  const max = Math.max(...sparkline);
  const points = sparkline.map(
    (value, index) => `${(index / (sparkline.length - 1)) * 100},${40 - (value / max) * 36}`,
  );

  return (
    <Section kicker={copy.kicker} title={copy.title} body={copy.body}>
      <Panel className="overflow-hidden p-2 home-shadow-lg">
        <div className="rounded-[1.25rem] bg-background p-4 sm:p-6 dark:bg-olive-950">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {copy.kpis.map((kpi) => (
              <div key={kpi.label} className="rounded-2xl border border-border p-4 dark:border-white/10">
                <div className="text-xs text-muted-foreground">{kpi.label}</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="font-heading text-2xl font-semibold tracking-tight">{kpi.value}</span>
                  <span className="text-xs font-medium text-teal-700 dark:text-teal-400">{kpi.delta}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <div className="overflow-x-auto rounded-2xl border border-border dark:border-white/10">
              <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-16 w-full" aria-hidden>
                <defs>
                  <linearGradient id="home-spark" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-teal-500)" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="var(--color-teal-500)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <polygon points={`0,40 ${points.join(' ')} 100,40`} fill="url(#home-spark)" />
                <polyline
                  points={points.join(' ')}
                  fill="none"
                  stroke="var(--color-teal-500)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <table className="w-full min-w-[520px] text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-y border-border dark:border-white/10">
                    {copy.columns.map((column) => (
                      <th key={column} className="px-3 py-2 font-medium">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {requests.map((row, index) => (
                    <tr key={index} className="border-b border-border last:border-0 dark:border-white/5">
                      <td className="px-3 py-2">{row.model}</td>
                      <td className="px-3 py-2 text-muted-foreground">{row.provider}</td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                            row.status === 200
                              ? 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200'
                              : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
                          )}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="px-3 py-2">{row.latency}</td>
                      <td className="px-3 py-2">{row.tokens}</td>
                      <td className="px-3 py-2">{row.cost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col rounded-2xl border border-border p-4 dark:border-white/10">
              <div className="font-mono text-xs font-semibold">{copy.traceTitle}</div>
              <div className="mt-4 flex flex-1 flex-col justify-around gap-3">
                {spans.map((span) => (
                  <div key={span.label}>
                    <div className="mb-1 font-mono text-[10px] text-muted-foreground">{span.label}</div>
                    <div className="relative h-2 rounded-full bg-muted dark:bg-white/5">
                      <div
                        className={cn('absolute inset-y-0 rounded-full', span.tone)}
                        style={{ left: `${span.start}%`, width: `${Math.max(span.width, 1)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground dark:border-white/10">
                <Activity className="size-3.5 text-teal-600 dark:text-teal-400" />
                {copy.otel}
              </div>
            </div>
          </div>
        </div>
      </Panel>
    </Section>
  );
}
