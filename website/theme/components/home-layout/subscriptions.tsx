import { Link } from '@rspress/core/theme';
import { Blocks, Plug } from 'lucide-react';

import { LobeIcon } from './lobe-icon';
import { Panel } from './panel';
import { Section } from './section';
import { useHomeCopy, useLocalePath } from './use-home-copy';

const subscriptions = [
  { slug: 'openai-chatgpt', icon: 'openai', name: 'ChatGPT', plan: 'Plus / Pro / Team' },
  { slug: 'claude-code', icon: 'claude-color', name: 'Claude', plan: 'Pro / Team / Max' },
  { slug: 'github-copilot', icon: 'githubcopilot', name: 'GitHub Copilot', plan: 'Individual / Enterprise' },
  { slug: 'google-antigravity', icon: 'antigravity-color', name: 'Google Antigravity', plan: 'Google account' },
  { slug: 'cursor', icon: 'cursor', name: 'Cursor', plan: 'IDE subscription' },
  { slug: 'xai-grok', icon: 'xai', name: 'xAI Grok', plan: 'Device login' },
  { slug: 'kimi-code', icon: 'moonshot', name: 'Kimi Code', plan: 'Device login' },
  { slug: 'openrouter', icon: 'openrouter-color', name: 'OpenRouter', plan: 'PKCE login' },
  { slug: 'opencode-go', icon: 'opencode', name: 'OpenCode Go', plan: 'OAuth' },
  { slug: 'muse-code', icon: 'meta-color', name: 'Muse Code', plan: 'Device login' },
] as const;

export function Subscriptions() {
  const copy = useHomeCopy().subscriptions;
  const oauthLink = useLocalePath('/guide/providers/oauth/');

  return (
    <Section kicker={copy.kicker} title={copy.title} body={copy.body}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {subscriptions.map((item) => (
          <Link
            key={item.slug}
            href={`${oauthLink}${item.slug}`}
            className="group flex flex-col gap-3 rounded-2xl border border-border bg-card/70 p-4 transition hover:-translate-y-0.5 hover:border-teal-500/50 dark:border-white/10 dark:bg-white/5"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background dark:border-white/10 dark:bg-white/5">
              <LobeIcon slug={item.icon} size={24} className="size-6" />
            </span>
            <div>
              <div className="font-semibold">{item.name}</div>
              <div className="text-xs text-muted-foreground">{item.plan}</div>
            </div>
          </Link>
        ))}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Panel className="flex items-start gap-4 p-5">
          <Plug className="mt-0.5 size-5 shrink-0 text-teal-600 dark:text-teal-400" />
          <div>
            <div className="font-semibold">{copy.anyApi}</div>
            <div className="text-sm text-muted-foreground">{copy.anyApiBody}</div>
          </div>
        </Panel>
        <Panel className="flex items-start gap-4 p-5">
          <Blocks className="mt-0.5 size-5 shrink-0 text-teal-600 dark:text-teal-400" />
          <div>
            <div className="font-semibold">{copy.anySdk}</div>
            <div className="text-sm text-muted-foreground">{copy.anySdkBody}</div>
          </div>
        </Panel>
      </div>
    </Section>
  );
}
