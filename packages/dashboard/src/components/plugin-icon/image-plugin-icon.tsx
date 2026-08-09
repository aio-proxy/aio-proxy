import { useState } from 'react';

export interface ImagePluginIconProps {
  readonly icon: string;
  readonly size?: number;
  readonly className?: string;
}

export const ImagePluginIcon: React.FC<ImagePluginIconProps> = ({ icon, size, className }) => {
  const [failed, setFailed] = useState(false);

  return failed ? null : (
    <img
      src={icon}
      className={className}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      role="img"
      onError={() => setFailed(true)}
    />
  );
};
