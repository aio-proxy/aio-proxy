import { cn } from 'cn';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { useHomeCopy } from './use-home-copy';

const installCommands = {
  brew: 'brew install aio-proxy/tap/aio-proxy',
  bun: 'bun add -g aio-proxy',
  curl: 'curl -fsSL https://aioproxy.dev/install.sh | sh',
} as const;

type InstallMethod = keyof typeof installCommands;

export function InstallCommand() {
  const copy = useHomeCopy();
  const [method, setMethod] = useState<InstallMethod>('brew');
  const [copied, setCopied] = useState(false);
  const command = installCommands[method];

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-(--home-code-border) bg-(--home-code-bg) text-(--home-code-fg) home-shadow">
      <div className="flex items-center gap-1 border-b border-(--home-code-border) bg-(--home-code-chrome) px-3 pt-2">
        {(Object.keys(installCommands) as InstallMethod[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setMethod(key)}
            className={cn(
              'rounded-t-lg px-3 py-1.5 font-mono text-xs transition-colors',
              method === key
                ? 'bg-(--home-code-tab) text-(--home-code-accent)'
                : 'text-(--home-code-muted) hover:text-(--home-code-fg)',
            )}
          >
            {key}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="font-mono text-sm text-(--home-code-accent) select-none">$</span>
        <code className="flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap">{command}</code>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? copy.hero.copied : copy.hero.copy}
          className="rounded-md p-1.5 text-(--home-code-muted) transition-colors hover:bg-(--home-code-tab) hover:text-(--home-code-fg)"
        >
          {copied ? <Check className="size-4 text-(--home-code-accent)" /> : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  );
}
