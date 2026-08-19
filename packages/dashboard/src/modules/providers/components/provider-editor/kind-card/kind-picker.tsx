import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import { BoxesIcon, KeyRoundIcon, ShieldCheckIcon } from 'lucide-react';
import type React from 'react';

import { PROVIDER_KIND_LABEL } from '../../../lib/constants';

// `satisfies` over the enum: adding a kind without a card here is a type error, not a missing card.
// The heading is `PROVIDER_KIND_LABEL`, the same acronyms the providers table shows — proper nouns
// that are identical in every locale, so only the hint below them is a message.
const KIND_CARDS = [
  {
    value: ProviderKind.Api,
    hintKey: 'dashboard.providers.editor.kind_api_hint',
    icon: KeyRoundIcon,
  },
  {
    value: ProviderKind.OAuth,
    hintKey: 'dashboard.providers.editor.kind_oauth_hint',
    icon: ShieldCheckIcon,
  },
  {
    value: ProviderKind.AiSdk,
    hintKey: 'dashboard.providers.editor.kind_ai_sdk_hint',
    icon: BoxesIcon,
  },
] as const satisfies readonly {
  value: ProviderKind;
  hintKey: keyof typeof m;
  icon: typeof KeyRoundIcon;
}[];

// Both axes, per the WAI-ARIA radiogroup pattern.
const ARROW_STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

interface KindPickerProps {
  readonly value: ProviderKind;
  readonly onChange: (kind: ProviderKind) => void;
  /** Kind is immutable once saved, so editing shows one settled line instead of three cards. */
  readonly locked?: boolean;
  /** The card heading already names this group; pointing at it beats repeating the text as a label. */
  readonly labelledBy: string;
}

export const KindPicker: React.FC<KindPickerProps> = ({ value, onChange, locked = false, labelledBy }) => {
  const currentIndex = KIND_CARDS.findIndex((card) => card.value === value);
  const current = KIND_CARDS[currentIndex] ?? KIND_CARDS[0];

  if (locked) {
    const Icon = current.icon;
    return (
      <p data-testid="provider-editor-kind-locked" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-4 shrink-0" />
        <span className="text-foreground">{PROVIDER_KIND_LABEL[current.value]}</span>
        {/* One flex child, so the separator keeps a plain space to the note it decorates instead of
            the row's `gap-2`. The dot is decoration; the note beside it carries the meaning. */}
        <span>
          <span aria-hidden>·</span> {m['dashboard.providers.editor.kind_locked_note']()}
        </span>
      </p>
    );
  }

  // Selection follows focus, and the roving tabIndex keeps the group to one tab stop.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = ARROW_STEP[event.key];
    if (step === undefined) return;
    event.preventDefault(); // the arrows move selection here, so they must not also scroll the page
    const next = KIND_CARDS[(currentIndex + step + KIND_CARDS.length) % KIND_CARDS.length] ?? current;
    onChange(next.value);
    event.currentTarget.querySelector<HTMLElement>(`[data-kind="${next.value}"]`)?.focus();
  };

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} onKeyDown={handleKeyDown} className="grid gap-2 sm:grid-cols-3">
      {KIND_CARDS.map((card) => {
        const Icon = card.icon;
        const selected = card.value === value;
        return (
          <button
            key={card.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            data-kind={card.value}
            onClick={() => onChange(card.value)}
            className={cn(
              'flex items-start gap-2.5 rounded-2xl border p-3 text-left transition-colors outline-none',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30',
              selected ? 'border-primary/40 bg-primary/5' : 'border-border hover:bg-muted/60',
            )}
          >
            <Icon className={cn('mt-0.5 size-4 shrink-0', selected ? 'text-primary' : 'text-muted-foreground')} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{PROVIDER_KIND_LABEL[card.value]}</span>
              <span className="block text-xs text-muted-foreground">{m[card.hintKey]()}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
};
