import { useEffect, useState } from 'react';
import type React from 'react';

import { LobeIcon } from '../lobe-icon';

interface PluginIconProps {
  readonly icon: string;
  readonly size?: number;
  readonly className?: string;
}

const isImageUrl = (icon: string): boolean => /^(?:https?:\/\/|data:image\/)/u.test(icon);

export const PluginIcon: React.FC<PluginIconProps> = ({ icon, size, className }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [icon]);

  if (isImageUrl(icon)) {
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
  }
  return <LobeIcon slug={icon} size={size} className={className} />;
};
