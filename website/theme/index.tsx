// Learn how to customize the theme: https://rspress.rs/guide/basic/custom-theme
import './index.css';
import { Badge as OriginalBadge, Tag as OriginalTag } from '@rspress/core/theme-original';

export function Tag({ tag }: { tag?: string }) {
  return tag?.trim() === 'GET' ? <OriginalBadge text="GET" type="tip" /> : <OriginalTag tag={tag} />;
}

export * from '@rspress/core/theme-original';
export { Layout } from './components/layout';
export { DocContent } from './components/doc-content';
export { HomeBackground } from './components/home-background';
export { NavTitle } from './components/nav-title';
export * from './components/icons';
export * from './components/command-tabs';
