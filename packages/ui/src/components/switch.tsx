'use client';

import { Switch as SwitchPrimitive } from '@base-ui/react/switch';

import { cn } from '#lib/utils';

// Safari 17.4+ reflects the `switch` attribute as an IDL property. Support cannot change at
// runtime, so this resolves once at module load rather than through a hook.
const supportsNativeSwitch = typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;

// The native path renders an <input>, so the Base UI escape hatches that only make sense for its
// <span> root are dropped rather than leaked onto the DOM as invalid attributes.
type SwitchProps = Omit<
  SwitchPrimitive.Root.Props,
  'render' | 'nativeButton' | 'inputRef' | 'uncheckedValue' | 'className' | 'style' | 'onCheckedChange'
> & {
  className?: string;
  style?: React.CSSProperties;
  size?: 'sm' | 'default';
  onCheckedChange?: (checked: boolean) => void;
};

function Switch({ className, size = 'default', onCheckedChange, ...props }: SwitchProps) {
  // `appearance: auto` only honours accent-color, so the native control cannot reproduce the `sm`
  // geometry; small switches stay on the Base UI implementation.
  if (supportsNativeSwitch && size === 'default') {
    return (
      <input
        {...props}
        type="checkbox"
        // @ts-expect-error `switch` is not in React's DOM attribute types yet
        switch=""
        data-slot="switch"
        className={cn(
          'peer shrink-0 align-middle accent-primary outline-none focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
      />
    );
  }

  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch relative inline-flex shrink-0 items-center rounded-2xl border-2 transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-5 data-[size=default]:w-8 data-[size=sm]:h-4 data-[size=sm]:w-6 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-unchecked:border-transparent data-unchecked:bg-input/90 data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className,
      )}
      {...props}
      onCheckedChange={onCheckedChange}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-2xl bg-background shadow-sm ring-0 transition-transform not-dark:bg-clip-padding group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-checked:translate-x-[calc(100%-4px)] dark:data-checked:bg-primary-foreground data-unchecked:translate-x-0 dark:data-unchecked:bg-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
