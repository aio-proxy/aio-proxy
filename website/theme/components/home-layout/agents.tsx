import { Check } from 'lucide-react';

import { InlineCode } from './inline-code';
import { Section } from './section';
import { useHomeCopy } from './use-home-copy';

const agentTerminal = [
  { kind: 'cmd', text: 'aiop agent configure codex' },
  { kind: 'ok', text: 'Detected Codex CLI 0.42 · profile ~/.codex' },
  { kind: 'ok', text: 'Injected provider "aio-proxy" into config.toml' },
  { kind: 'ok', text: 'Issued local agent token (rotates automatically)' },
  { kind: 'ok', text: 'Migrated 38 sessions · rollback journal saved' },
  { kind: 'cmd', text: 'aiop agent list' },
  { kind: 'out', text: 'codex     connected   opencode  connected' },
  { kind: 'out', text: 'grok      connected   pi        not installed' },
] as const;

export function Agents() {
  const copy = useHomeCopy().agents;

  return (
    <Section kicker={copy.kicker} title={copy.title} body={<InlineCode text={copy.body} />}>
      <div className="grid gap-8 lg:grid-cols-[1fr_1.2fr] lg:items-center">
        <div className="flex flex-col gap-4">
          {copy.points.map((point) => (
            <div key={point} className="flex items-start gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300">
                <Check className="size-3" />
              </span>
              <span>{point}</span>
            </div>
          ))}
          <p className="mt-4 border-l-2 border-teal-500/50 pl-4 text-sm text-muted-foreground">{copy.baseUrl}</p>
        </div>
        <div className="overflow-hidden rounded-3xl border border-(--home-code-border) bg-(--home-code-bg) font-mono text-[13px] leading-relaxed text-(--home-code-fg) home-shadow">
          <div className="flex items-center gap-2 border-b border-(--home-code-border) bg-(--home-code-chrome) px-5 py-3">
            <span className="size-2.5 rounded-full bg-red-400/70" />
            <span className="size-2.5 rounded-full bg-amber-400/70" />
            <span className="size-2.5 rounded-full bg-teal-400/70" />
          </div>
          <div className="flex flex-col gap-1 overflow-x-auto p-5">
            {agentTerminal.map((line, index) => (
              <div
                key={line.text}
                className="animate-in fade-in fill-mode-both slide-in-from-left-1 whitespace-pre"
                style={{ animationDelay: `${index * 120}ms` }}
              >
                {line.kind === 'cmd' ? (
                  <span className={index > 0 ? 'mt-3 inline-block' : undefined}>
                    <span className="text-(--home-code-accent)">$ </span>
                    {line.text}
                  </span>
                ) : null}
                {line.kind === 'ok' ? (
                  <span className="text-(--home-code-muted)">
                    <span className="text-(--home-code-accent)">✓ </span>
                    {line.text}
                  </span>
                ) : null}
                {line.kind === 'out' ? <span className="text-(--home-code-muted)">{line.text}</span> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
