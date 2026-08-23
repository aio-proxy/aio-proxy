import { useTheme } from 'next-themes';

interface LobeIconProps {
  slug: string;
  size?: number;
  className?: string;
}

export const LobeIcon: React.FC<LobeIconProps> = ({ slug, size, className }) => {
  const { resolvedTheme } = useTheme();
  return (
    <picture>
      <source
        srcSet={`https://fastly.jsdelivr.net/npm/@lobehub/icons-static-webp@latest/${resolvedTheme}/${slug}.webp`}
        type="image/webp"
      />
      <img
        src={`https://fastly.jsdelivr.net/npm/@lobehub/icons-static-png@latest/${resolvedTheme}/${slug}.png`}
        width={size}
        height={size}
        className={className}
        alt=""
        aria-hidden="true"
        role="img"
      />
    </picture>
  );
};

export const withLobeIcon =
  (slug: string): React.FC<Omit<LobeIconProps, 'slug'>> =>
  (props) => <LobeIcon slug={slug} {...props} />;
