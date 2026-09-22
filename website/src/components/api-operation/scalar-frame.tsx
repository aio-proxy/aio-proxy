import { type FormEvent, useState } from 'react';

import { selectedServer } from './server-url';

type ScalarFrameProps = {
  readonly ApiReference: typeof import('@scalar/api-reference-react').ApiReferenceReact;
  readonly dark: boolean;
  readonly document: Readonly<Record<string, unknown>>;
  readonly operationKey: string;
};

const defaultServer = 'http://127.0.0.1:9317';

const copy = {
  en: {
    active: 'Selected server',
    apply: 'Use server',
    help: 'Try It sends requests directly from your browser to this server.',
    invalid: 'Use an absolute HTTP or HTTPS server outside this documentation site.',
    label: 'Server URL',
  },
  zh: {
    active: '当前服务地址',
    apply: '使用此地址',
    help: '“Try It” 会从浏览器直接向此服务地址发送请求。',
    invalid: '请输入不属于本站的绝对 HTTP 或 HTTPS 服务地址。',
    label: '服务地址',
  },
} as const;

const pageOrigin = (): string => globalThis.location?.origin ?? 'https://aioproxy.dev';

export function ScalarFrame({ ApiReference, dark, document, operationKey }: ScalarFrameProps) {
  const locale = operationKey.startsWith('zh:') ? 'zh' : 'en';
  const text = copy[locale];
  const [input, setInput] = useState('');
  const [server, setServer] = useState(() => selectedServer(defaultServer, pageOrigin()));
  const [requestError, setRequestError] = useState<string>();
  const helpId = `${operationKey.replace(':', '-')}-server-help`;
  const errorId = `${operationKey.replace(':', '-')}-server-error`;

  const selectServer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      setServer(selectedServer(input, pageOrigin()));
      setRequestError(undefined);
    } catch {
      setRequestError(text.invalid);
    }
  };

  return (
    <div className="api-operation" data-not-typeset>
      <form className="api-operation-server" noValidate onSubmit={selectServer}>
        <label htmlFor={`${operationKey}-server`}>{text.label}</label>
        <div className="api-operation-server__controls">
          <input
            id={`${operationKey}-server`}
            type="url"
            value={input}
            placeholder={defaultServer}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={`${helpId}${requestError ? ` ${errorId}` : ''}`}
            aria-invalid={requestError ? true : undefined}
            onChange={(event) => setInput(event.currentTarget.value)}
          />
          <button type="submit">{text.apply}</button>
        </div>
        <p id={helpId} className="api-operation-server__help">
          {text.help} {text.active}: <code>{server}</code>
        </p>
        {requestError ? (
          <p id={errorId} className="api-operation-server__error" role="alert">
            {requestError}
          </p>
        ) : null}
      </form>
      <ApiReference
        key={`${operationKey}:${server}`}
        configuration={{
          content: document,
          servers: [{ url: server }],
          layout: 'modern',
          showSidebar: false,
          showDeveloperTools: 'never',
          hideModels: true,
          hideSearch: true,
          hideDarkModeToggle: true,
          hideClientButton: true,
          documentDownloadType: 'none',
          defaultOpenAllTags: true,
          withDefaultFonts: false,
          agent: { disabled: true },
          persistAuth: false,
          telemetry: false,
          forceDarkModeState: dark ? 'dark' : 'light',
          onServerChange: (value) => {
            try {
              selectedServer(value, pageOrigin());
              setRequestError(undefined);
            } catch {
              setRequestError(text.invalid);
            }
          },
          onRequestBuilt: ({ request }) => {
            try {
              selectedServer(request.url, pageOrigin());
              setRequestError(undefined);
            } catch (error) {
              setRequestError(text.invalid);
              throw error;
            }
          },
        }}
      />
    </div>
  );
}
