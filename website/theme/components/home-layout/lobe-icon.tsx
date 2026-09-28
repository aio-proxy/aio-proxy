import { useDark } from '@rspress/core/runtime';

interface LobeIconProps {
  readonly slug: string;
  readonly size?: number;
  readonly className?: string;
}

// Mirrors the dashboard's LobeIcon: the same @lobehub/icons-static CDN assets the plugins declare as `icon`.
export function LobeIcon({ slug, size, className }: LobeIconProps) {
  const theme = useDark() ? 'dark' : 'light';
  return (
    <picture>
      <source
        srcSet={`https://fastly.jsdelivr.net/npm/@lobehub/icons-static-webp@latest/${theme}/${slug}.webp`}
        type="image/webp"
      />
      <img
        src={`https://fastly.jsdelivr.net/npm/@lobehub/icons-static-png@latest/${theme}/${slug}.png`}
        width={size}
        height={size}
        className={className}
        alt=""
        aria-hidden="true"
        loading="lazy"
      />
    </picture>
  );
}
