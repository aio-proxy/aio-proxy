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
          hideModels: true,
          hideSearch: true,
          hideDarkModeToggle: true,
          hideClientButton: true,
          documentDownloadType: 'none',
          withDefaultFonts: false,
          forceDarkModeState: dark ? 'dark' : 'light',
        }}
      />
    </div>
  );
}
