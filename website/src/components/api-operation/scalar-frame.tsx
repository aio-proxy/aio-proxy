import type { ApiOperationSlug } from './fixtures';
import { chatCompletionsDocument, listModelsDocument } from './fixtures';

type ScalarFrameProps = {
  readonly ApiReference: typeof import('@scalar/api-reference-react').ApiReferenceReact;
  readonly dark: boolean;
  readonly slug: ApiOperationSlug;
};

const documents = {
  'list-models': listModelsDocument,
  'chat-completions': chatCompletionsDocument,
} as const;

export function ScalarFrame({ ApiReference, dark, slug }: ScalarFrameProps) {
  return (
    <div className="api-operation" data-not-typeset>
      <ApiReference
        key={slug}
        configuration={{
          content: documents[slug],
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
