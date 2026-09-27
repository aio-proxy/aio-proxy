interface OmpIconProps {
  readonly size?: number;
  readonly className?: string;
}

/** lobehub publishes no oh-my-pi icon, so its site favicon is used instead. */
export const OmpIcon: React.FC<OmpIconProps> = ({ size, className }) => (
  <img src="https://omp.sh/favicon.svg" width={size} height={size} className={className} alt="" aria-hidden="true" />
);
