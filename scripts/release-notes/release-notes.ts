/** Preserve the Changesets body for one version without neighboring releases. */
export function releaseNotes(changelog: string, version: string): string | undefined {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === `## ${version}`);
  if (start < 0) return undefined;
  const after = lines.slice(start + 1);
  const nextSection = after.findIndex((line) => /^##\s/.test(line));
  return (nextSection < 0 ? after : after.slice(0, nextSection)).join('\n').trim() || undefined;
}
