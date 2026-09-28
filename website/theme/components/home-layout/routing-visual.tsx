import { AioProxyLogo } from '@aio-proxy/brand';
import { cn } from 'cn';
import { useEffect, useState } from 'react';

const clients = [
  { name: 'Claude Code', protocol: 'anthropic' },
  { name: 'Codex', protocol: 'openai-response' },
  { name: 'Cursor', protocol: 'openai-compatible' },
  { name: 'Gemini SDK', protocol: 'gemini' },
] as const;

const providers = [
  { name: 'Anthropic', detail: 'api' },
  { name: 'ChatGPT Pro', detail: 'oauth' },
  { name: 'GitHub Copilot', detail: 'oauth' },
  { name: 'OpenRouter', detail: 'api' },
  { name: 'Google Gemini', detail: 'api' },
] as const;

// Each tick sends one client's request to a Provider; the pairs are hand-picked to show both passthrough and conversion.
const flows = [
  { client: 0, provider: 0, mode: 'passthrough' },
  { client: 1, provider: 1, mode: 'passthrough' },
  { client: 2, provider: 2, mode: 'convert' },
  { client: 3, provider: 4, mode: 'passthrough' },
  { client: 0, provider: 3, mode: 'convert' },
  { client: 1, provider: 2, mode: 'convert' },
] as const;

const rowY = (index: number, count: number) => ((index + 0.5) / count) * 100;

export function RoutingVisual() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1800);
    return () => window.clearInterval(timer);
  }, []);

  const flow = flows[tick % flows.length];

  return (
    <div className="relative mx-auto w-full max-w-xl">
      <div className="relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-0 rounded-[2rem] border border-border bg-card/70 p-4 home-shadow-lg backdrop-blur-md sm:p-6 dark:border-white/10 dark:bg-olive-900/70">
        <ul className="flex flex-col justify-around gap-2">
          {clients.map((client, index) => (
            <li
              key={client.name}
              className={cn(
                'rounded-xl border px-2.5 py-2 text-xs transition-all duration-500 sm:px-3 sm:text-sm',
                flow.client === index
                  ? 'border-teal-500/60 bg-teal-50 dark:bg-teal-950/60'
                  : 'border-border bg-background/60 dark:border-white/10 dark:bg-white/5',
              )}
            >
              <div className="font-medium">{client.name}</div>
              <div className="truncate font-mono text-[10px] text-muted-foreground">{client.protocol}</div>
            </li>
          ))}
        </ul>

        <div className="relative flex w-20 items-center justify-center sm:w-36">
          <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100" aria-hidden>
            {clients.map((client, index) => (
              <path
                key={client.name}
                d={`M0 ${rowY(index, clients.length)} C 30 ${rowY(index, clients.length)}, 30 50, 50 50`}
                fill="none"
                vectorEffect="non-scaling-stroke"
                className={cn(
                  'transition-all duration-500',
                  flow.client === index ? 'home-dash stroke-teal-500' : 'stroke-olive-300 dark:stroke-olive-700',
                )}
                strokeWidth={flow.client === index ? 2 : 1}
                strokeDasharray={flow.client === index ? '4 4' : undefined}
              />
            ))}
            {providers.map((provider, index) => (
              <path
                key={provider.name}
                d={`M50 50 C 70 50, 70 ${rowY(index, providers.length)}, 100 ${rowY(index, providers.length)}`}
                fill="none"
                vectorEffect="non-scaling-stroke"
                className={cn(
                  'transition-all duration-500',
                  flow.provider === index ? 'home-dash stroke-teal-500' : 'stroke-olive-300 dark:stroke-olive-700',
                )}
                strokeWidth={flow.provider === index ? 2 : 1}
                strokeDasharray={flow.provider === index ? '4 4' : undefined}
              />
            ))}
          </svg>
          <div className="relative z-10 flex flex-col items-center gap-1.5 rounded-2xl border border-teal-500/50 bg-background px-3 py-3 home-shadow dark:bg-olive-950">
            <AioProxyLogo className="text-xs sm:text-sm" />
            <span
              key={tick}
              className={cn(
                'animate-in fade-in zoom-in-95 rounded-full px-2 py-0.5 font-mono text-[9px] font-medium whitespace-nowrap duration-300',
                flow.mode === 'passthrough'
                  ? 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200',
              )}
            >
              {flow.mode === 'passthrough' ? 'passthrough' : 'convert'}
            </span>
          </div>
        </div>

        <ul className="flex flex-col justify-around gap-2">
          {providers.map((provider, index) => (
            <li
              key={provider.name}
              className={cn(
                'flex items-center justify-between gap-2 rounded-xl border px-2.5 py-1.5 text-xs transition-all duration-500 sm:px-3 sm:text-sm',
                flow.provider === index
                  ? 'border-teal-500/60 bg-teal-50 dark:bg-teal-950/60'
                  : 'border-border bg-background/60 dark:border-white/10 dark:bg-white/5',
              )}
            >
              <span className="truncate font-medium">{provider.name}</span>
              <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">{provider.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
