type ScalarFrameProps = {
  readonly ApiReference: typeof import('@scalar/api-reference-react').ApiReferenceReact;
  readonly dark: boolean;
  readonly document: Readonly<Record<string, unknown>>;
  readonly operationKey: string;
};

export function ScalarFrame({ ApiReference, dark, document, operationKey }: ScalarFrameProps) {
  return (
    <div className="api-operation" data-not-typeset>
      <ApiReference
        key={operationKey}
        configuration={{
          content: document,
          servers: [{ url: 'http://127.0.0.1:9317' }],
          layout: 'modern',
          showSidebar: false,
          showDeveloperTools: 'never',
          hideModels: true,
          hideSearch: true,
          hideDarkModeToggle: true,
          hideClientButton: true,
          hideTestRequestButton: true,
          defaultHttpClient: { targetKey: 'js', clientKey: 'fetch' },
          hiddenClients: {
            c: true,
            clojure: true,
            csharp: true,
            dart: true,
            fsharp: true,
            http: true,
            julia: true,
            kotlin: true,
            node: true,
            objc: true,
            ocaml: true,
            powershell: true,
            r: true,
            rust: true,
            swift: true,
            java: ['asynchttp', 'okhttp', 'unirest'],
            js: ['axios', 'jquery', 'ofetch', 'xhr'],
            php: ['guzzle', 'laravel'],
            python: ['python3', 'aiohttp', 'httpx_sync', 'httpx_async'],
            shell: ['httpie', 'wget'],
          },
          documentDownloadType: 'none',
          defaultOpenAllTags: true,
          withDefaultFonts: false,
          agent: { disabled: true },
          persistAuth: false,
          telemetry: false,
          forceDarkModeState: dark ? 'dark' : 'light',
        }}
      />
    </div>
  );
}
