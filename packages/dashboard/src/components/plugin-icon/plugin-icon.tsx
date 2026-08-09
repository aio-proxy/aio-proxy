import type React from 'react';

import { LobeIcon } from '../lobe-icon';
import { ImagePluginIcon } from './image-plugin-icon';

interface PluginIconProps {
  readonly icon: string;
  readonly size?: number;
  readonly className?: string;
}

const isImageUrl = (icon: string): boolean => /^(?:https?:\/\/|data:image\/)/u.test(icon);

export const PluginIcon: React.FC<PluginIconProps> = ({ icon, size, className }) => {
  if (isImageUrl(icon)) {
    return <ImagePluginIcon key={icon} icon={icon} size={size} className={className} />;
  }
  return <LobeIcon slug={icon} size={size} className={className} />;
};
