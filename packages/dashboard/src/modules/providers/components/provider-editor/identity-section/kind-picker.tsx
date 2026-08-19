import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import { BoxesIcon, KeyRoundIcon, ShieldCheckIcon } from 'lucide-react';
import type React from 'react';

// `satisfies` over the enum: adding a kind without a card here is a type error, not a missing card.
const KIND_CARDS = [
  {
    value: ProviderKind.Api,
    labelKey: 'dashboard.providers.editor.kind_api',
    hintKey: 'dashboard.providers.editor.kind_api_hint',
    icon: KeyRoundIcon,
  },
  {
    value: ProviderKind.OAuth,
    labelKey: 'dashboard.providers.editor.kind_oauth',
    hintKey: 'dashboard.providers.editor.kind_oauth_hint',
    icon: ShieldCheckIcon,
  },
  {
    value: ProviderKind.AiSdk,
    labelKey: 'dashboard.providers.editor.kind_ai_sdk',
    hintKey: 'dashboard.providers.editor.kind_ai_sdk_hint',
    icon: BoxesIcon,
  },
] as const satisfies readonly {
  value: ProviderKind;
  labelKey: keyof typeof m;
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
}

export const KindPicker: React.FC<KindPickerProps> = ({ value, onChange, locked = false }) => {
  const currentIndex = KIND_CARDS.findIndex((card) => card.value === value);
  const current = KIND_CARDS[currentIndex] ?? KIND_CARDS[0];

  if (locked) {
    const Icon = current.icon;
    return (
      <p data-testid="provider-editor-kind-locked" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-4 shrink-0" />
        <span className="text-foreground">{m[current.labelKey]()}</span>
        {/* The separator is decoration; the note beside it carries the meaning. */}
        <span aria-hidden>·</span>
        <span>{m['dashboard.providers.editor.kind_locked_note']()}</span>
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
    <div
      role="radiogroup"
      aria-label={m['dashboard.providers.editor.kind_label']()}
      onKeyDown={handleKeyDown}
      className="grid gap-2 sm:grid-cols-3"
    >
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
              <span className="block text-sm font-medium">{m[card.labelKey]()}</span>
              <span className="block text-xs text-muted-foreground">{m[card.hintKey]()}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
};
