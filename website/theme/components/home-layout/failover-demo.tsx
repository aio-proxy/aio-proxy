import { CodeBlockRuntime } from '@rspress/core/theme';
import { cn } from 'cn';
import { CircleCheck, CircleX, Clock, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Panel } from './panel';
import { Section } from './section';
import { useHomeCopy } from './use-home-copy';

const configSnippet = `{
  "providers": {
    "claude-team": {
      "kind": "plugin",
      "plugin": "@aio-proxy/plugin-claude-code",
      "priority": 100, "weight": 3
    },
    "anthropic-key": {
      "kind": "api", "protocol": "anthropic",
      "apiKey": "{{env.ANTHROPIC_API_KEY}}",
      "models": ["claude-sonnet-4-6"],
      "priority": 100, "weight": 1
    },
    "openrouter": {
      "kind": "plugin",
      "plugin": "@aio-proxy/plugin-openrouter"
    }
  }
}`;

// The sample is illustrative, so hide the copy and wrap buttons. The type still asks for `copyElementRef`,
// but CodeBlock always overrides it with its own ref. Module-level keeps the prop stable across renders.
const codeButtons = { copyElementRef: { current: null }, showCopyButton: false, showWrapCodeButton: false };

// Phase 0: idle, 1: first attempt, 2: first attempt failed + second attempt, 3: served.
const phaseDelays = [600, 1200, 1400] as const;

export function FailoverDemo() {
  const copy = useHomeCopy().routing;
  const [phase, setPhase] = useState(0);
  const [run, setRun] = useState(0);

  useEffect(() => {
    let elapsed = 0;
    const timers = phaseDelays.map((delay, index) => {
      elapsed += delay;
      return window.setTimeout(() => setPhase(index + 1), elapsed);
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [run]);

  const attempts = [
    {
      id: 'claude-team',
      tier: 100,
      weight: 3,
      state: phase === 1 ? 'pending' : phase >= 2 ? 'failed' : 'idle',
      note: copy.rateLimited,
      ms: '212 ms',
    },
    {
      id: 'anthropic-key',
      tier: 100,
      weight: 1,
      state: phase === 2 ? 'pending' : phase >= 3 ? 'served' : 'idle',
      note: copy.served,
      ms: '480 ms',
    },
    { id: 'openrouter', tier: 0, weight: 1, state: 'standby', note: copy.standby, ms: '' },
  ] as const;

  return (
    <Section kicker={copy.kicker} title={copy.title} body={copy.body}>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel className="flex flex-col p-6 sm:p-8">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 font-mono text-sm">
              <span className="rounded-md bg-teal-600 px-2 py-0.5 text-xs font-semibold text-white">
                {copy.request}
              </span>
              <span className="text-muted-foreground">model:</span>
              <span className="font-semibold">claude-sonnet-4-6</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setPhase(0);
                setRun((value) => value + 1);
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs transition hover:bg-muted dark:border-white/15 dark:hover:bg-white/10"
            >
              <RotateCcw className="size-3" />
              {copy.replay}
            </button>
          </div>

          <ol className="mt-6 flex flex-col gap-3">
            {attempts.map((attempt, index) => (
              <li
                key={attempt.id}
                className={cn(
                  'flex items-center gap-4 rounded-2xl border px-4 py-3.5 transition-all duration-500',
                  attempt.state === 'pending' && 'border-teal-500/60 bg-teal-50/60 dark:bg-teal-950/40',
                  attempt.state === 'failed' && 'border-red-500/30 bg-red-50/60 dark:bg-red-950/20',
                  attempt.state === 'served' && 'border-teal-500 bg-teal-50 dark:bg-teal-950/60',
                  (attempt.state === 'idle' || attempt.state === 'standby') &&
                    'border-border bg-background/60 dark:border-white/10 dark:bg-white/5',
                  attempt.state === 'standby' && 'opacity-60',
                )}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs dark:bg-white/10">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm font-semibold">{attempt.id}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {copy.tier} {attempt.tier} · weight {attempt.weight}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-right text-xs">
                  {attempt.state === 'pending' ? <Clock className="size-4 animate-spin text-teal-600" /> : null}
                  {attempt.state === 'failed' ? (
                    <>
                      <span className="text-red-700 dark:text-red-400">{attempt.note}</span>
                      <CircleX className="size-4 text-red-600" />
                    </>
                  ) : null}
                  {attempt.state === 'served' ? (
                    <>
                      <span className="font-medium text-teal-800 dark:text-teal-300">
                        {attempt.note} · {attempt.ms}
                      </span>
                      <CircleCheck className="size-4 text-teal-600" />
                    </>
                  ) : null}
                  {attempt.state === 'standby' ? <span className="text-muted-foreground">{attempt.note}</span> : null}
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-8 grid grid-cols-2 gap-4">
            {copy.points.map((point) => (
              <div key={point.title}>
                <div className="text-sm font-semibold">{point.title}</div>
                <div className="mt-1 text-sm text-muted-foreground">{point.body}</div>
              </div>
            ))}
          </div>
        </Panel>

        <div className="home-config-code min-w-0">
          <CodeBlockRuntime
            lang="jsonc"
            title="~/.aio-proxy/config.jsonc"
            code={configSnippet}
            codeButtonGroupProps={codeButtons}
          />
        </div>
      </div>
    </Section>
  );
}
