import { useLang, useSite } from '@rspress/core/runtime';

import { type HomeCopy, homeCopy } from './copy';

export function useHomeCopy(): HomeCopy {
  return useLang() === 'zh' ? homeCopy.zh : homeCopy.en;
}

// Rspress serves the default locale at the root and every other locale under `/<lang>`.
export function useLocalePath(path: string): string {
  const { site } = useSite();
  const lang = useLang();
  return lang && lang !== site?.lang ? `/${lang}${path}` : path;
}
