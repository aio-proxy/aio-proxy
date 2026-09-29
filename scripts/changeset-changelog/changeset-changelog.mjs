import changelogGithub from '@changesets/changelog-github';

const GITHUB_AUTHOR_LINK = /\[@([A-Za-z0-9-]+)\]\(https?:\/\/github\.com\/\1\)/g;
const THANKS_PUNCTUATION = /(Thanks (?:@[A-Za-z0-9-]+(?:, )?)+)! - /g;

export function stripGitHubAuthorLinks(line) {
  return line.replace(GITHUB_AUTHOR_LINK, '@$1');
}

export function renderReleaseLine(line, options = {}) {
  const hasAuthorLink = GITHUB_AUTHOR_LINK.test(line);
  GITHUB_AUTHOR_LINK.lastIndex = 0;
  const strippedLine = stripGitHubAuthorLinks(line);
  return hasAuthorLink && options.removeThanksPunctuation !== false
    ? strippedLine.replace(THANKS_PUNCTUATION, '$1 - ')
    : strippedLine;
}

export async function getReleaseLine(changeset, type, options) {
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
