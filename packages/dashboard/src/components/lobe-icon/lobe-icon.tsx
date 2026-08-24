import { useTheme } from 'next-themes';

interface LobeIconProps {
  slug: string;
  size?: number;
  className?: string;
}

export const LobeIcon: React.FC<LobeIconProps> = ({ slug, size, className }) => {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light';
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
        role="img"
      />
    </picture>
  );
};

export const withLobeIcon =
  (slug: string): React.FC<Omit<LobeIconProps, 'slug'>> =>
  (props) => <LobeIcon slug={slug} {...props} />;
