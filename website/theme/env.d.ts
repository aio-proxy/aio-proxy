declare module '*.css';

interface ImportMetaEnv {
  /** Set by rspress while rendering pages to Markdown for llms.txt (SSG-MD). */
  readonly SSG_MD: boolean;
}
