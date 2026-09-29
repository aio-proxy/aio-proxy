import changelogGithub from '@changesets/changelog-github';

type RenderOptions = {
  readonly removeThanksPunctuation?: boolean;
};

type Changeset = Parameters<typeof changelogGithub.getReleaseLine>[0];
type ReleaseType = Parameters<typeof changelogGithub.getReleaseLine>[1];
type ChangelogOptions = Parameters<typeof changelogGithub.getReleaseLine>[2];

const GITHUB_AUTHOR_LINK = /\[@([A-Za-z0-9-]+)\]\(https?:\/\/github\.com\/\1\)/g;
const THANKS_PUNCTUATION = /^(\s*(?:-\s*)?(?:\[[^\]]+\]\([^)]+\)\s*)*Thanks (?:@[A-Za-z0-9-]+(?:, )?)+)! - /;

export function stripGitHubAuthorLinks(line: string): string {
  return line.replace(GITHUB_AUTHOR_LINK, '@$1');
}

export function renderReleaseLine(line: string, options: RenderOptions = {}): string {
  const hasAuthorLink = GITHUB_AUTHOR_LINK.test(line);
  GITHUB_AUTHOR_LINK.lastIndex = 0;
  const strippedLine = stripGitHubAuthorLinks(line);
  return hasAuthorLink && options.removeThanksPunctuation !== false
    ? strippedLine.replace(THANKS_PUNCTUATION, '$1 - ')
    : strippedLine;
}

export async function getReleaseLine(changeset: Changeset, type: ReleaseType, options: ChangelogOptions) {
  const line = await changelogGithub.getReleaseLine(changeset, type, options);
  const hasGeneratedAuthor = changeset.commit !== undefined || /^\s*(?:author|user):\s*@?\S+/im.test(changeset.summary);
  return renderReleaseLine(line, {
    removeThanksPunctuation: !options?.disableThanks && hasGeneratedAuthor,
  });
}

export const getDependencyReleaseLine = changelogGithub.getDependencyReleaseLine;

export default {
  getDependencyReleaseLine,
  getReleaseLine,
};
