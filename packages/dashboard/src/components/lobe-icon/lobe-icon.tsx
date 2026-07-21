interface LobeIconProps {
  slug: string;
  size?: number;
  className?: string;
}

export const LobeIcon: React.FC<LobeIconProps> = ({ slug, size, className }) => {
  return (
    <picture>
      <source
        srcSet={`https://fastly.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${slug}.svg`}
        type="image/svg+xml"
      />
      <source
        srcSet={`https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${slug}.svg`}
        type="image/svg+xml"
      />
      <img
        src={`https://unpkg.com/@lobehub/icons-static-svg@latest/icons/${slug}.svg`}
        width={size}
        height={size}
        className={className}
        alt=""
      />
    </picture>
  );
};

export const withLobeIcon =
  (slug: string): React.FC<Omit<LobeIconProps, "slug">> =>
  (props) => <LobeIcon slug={slug} {...props} />;
