import { cn } from 'cn';
import { ArrowRight, Shuffle, Zap } from 'lucide-react';
import { useState } from 'react';

import { OptionList } from './option-list';
import { Panel } from './panel';
import { Section } from './section';
import { useHomeCopy } from './use-home-copy';

const clientProtocols = [
  { id: 'openai-response', name: 'OpenAI Responses', path: '/v1/responses' },
  { id: 'openai-compatible', name: 'Chat Completions', path: '/v1/chat/completions' },
  { id: 'anthropic', name: 'Anthropic Messages', path: '/v1/messages' },
  { id: 'gemini', name: 'Gemini', path: '/v1beta/models/*:generateContent' },
] as const;

const upstreams = [
  { id: 'openai-response', name: 'OpenAI Responses API' },
  { id: 'openai-compatible', name: 'OpenAI-compatible' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'gemini', name: 'Google Gemini' },
  { id: 'ai-sdk', name: 'AI SDK provider package' },
] as const;

export function ProtocolMatrix() {
  const copy = useHomeCopy().protocols;
  const [client, setClient] = useState<(typeof clientProtocols)[number]['id']>('anthropic');
  const [upstream, setUpstream] = useState<(typeof upstreams)[number]['id']>('openai-response');
  const passthrough = client === upstream;

  return (
    <Section kicker={copy.kicker} title={copy.title} body={copy.body}>
      <Panel className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[1fr_1.1fr_1fr] lg:items-center">
        <OptionList
          label={copy.clientLabel}
          items={clientProtocols}
          selected={client}
          onSelect={setClient}
          detail={(item) => item.path}
        />

        <div
          key={`${client}-${upstream}`}
          className={cn(
            'animate-in fade-in slide-in-from-bottom-2 flex flex-col items-center gap-4 rounded-2xl border p-6 text-center duration-300',
            passthrough
              ? 'border-teal-500/40 bg-teal-50/70 dark:bg-teal-950/40'
              : 'border-amber-500/40 bg-amber-50/70 dark:bg-amber-950/30',
          )}
        >
          <div
            className={cn(
              'flex size-14 items-center justify-center rounded-2xl',
              passthrough
                ? 'bg-teal-600 text-white dark:bg-teal-500 dark:text-olive-950'
                : 'bg-amber-500 text-white dark:text-olive-950',
            )}
          >
            {passthrough ? <Zap className="size-7" /> : <Shuffle className="size-7" />}
          </div>
          <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            {client}
            <ArrowRight className="size-3" />
            {upstream}
          </div>
          <h3 className="font-heading text-xl font-semibold">
            {passthrough ? copy.passthroughTitle : copy.convertTitle}
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {passthrough ? copy.passthroughBody : copy.convertBody}
          </p>
        </div>

        <OptionList label={copy.upstreamLabel} items={upstreams} selected={upstream} onSelect={setUpstream} />
      </Panel>
      <p className="mt-4 text-center text-sm text-muted-foreground">{copy.more}</p>
    </Section>
  );
}
