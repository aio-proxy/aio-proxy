import { useId } from 'react';

interface OmpIconProps {
  readonly size?: number;
  readonly className?: string;
}

/** oh-my-pi's own mark (the omp.sh favicon); lobehub publishes no icon for it. */
export const OmpIcon: React.FC<OmpIconProps> = ({ size, className }) => {
  const gradient = useId();
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ed4abf" />
          <stop offset=".5" stopColor="#9b4dff" />
          <stop offset="1" stopColor="#5ad8e6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="12" fill="#0f0a14" />
      <path fill={`url(#${gradient})`} d="M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z" />
    </svg>
  );
};
