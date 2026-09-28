import { m } from '@aio-proxy/i18n';
import type React from 'react';

interface RoutingProfileValueProps {
  readonly label: string;
  /** The model's own override, already formatted; `undefined` when the field follows the reference. */
  readonly own: string | undefined;
  readonly inherited: string | undefined;
}

/**
 * One `dt`/`dd` pair of an effective value. An override carries a dot and names the value it
 * replaces on hover, so the card shows what is in effect without hiding where it came from.
 */
export const RoutingProfileValue: React.FC<RoutingProfileValueProps> = ({ label, own, inherited }) => {
  const value = own ?? inherited;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className="flex min-w-0 items-center justify-end gap-1.5 text-right tabular-nums"
        title={
          own === undefined
            ? undefined
            : m['dashboard.routing.profile.overridden_title']({
                value: inherited ?? m['dashboard.routing.profile.not_set'](),
              })
        }
      >
        {own === undefined ? null : (
          <span
            role="img"
            aria-label={m['dashboard.routing.profile.overridden']()}
            className="size-1.5 shrink-0 rounded-full bg-primary"
          />
        )}
        <span className="truncate">
          {value ?? <span className="text-muted-foreground">{m['dashboard.routing.profile.not_set']()}</span>}
        </span>
      </dd>
    </>
  );
};
