import { useEffect, useState } from 'react';
import type React from 'react';

import { LobeIcon } from '../lobe-icon';

interface PluginIconProps {
  readonly icon: string;
  readonly size?: number;
}

const isImageUrl = (icon: string): boolean => /^(?:https?:\/\/|data:image\/)/u.test(icon);

export const PluginIcon: React.FC<PluginIconProps> = ({ icon, size }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [icon]);

  if (isImageUrl(icon)) {
    return failed ? null : (
      <img src={icon} width={size} height={size} alt="" aria-hidden="true" role="img" onError={() => setFailed(true)} />
    );
  }
  return <LobeIcon slug={icon} {...(size === undefined ? {} : { size })} />;
};
