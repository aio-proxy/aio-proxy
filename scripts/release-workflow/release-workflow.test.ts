import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Execute the actual workflow shell against a fake immutable-release API boundary.
// Published releases reject uploads; creating with attachments publishes them together.
test('publishes the Release with all assets before immutability locks it', async () => {
  const workflow = Bun.YAML.parse(await Bun.file('.github/workflows/release.yml').text()) as {
    jobs: { release: { steps: { uses?: string; with?: Record<string, unknown>; run?: string }[] } };
  };
  const steps = workflow.jobs.release.steps;
  const changesets = steps.find((step) => step.uses?.startsWith('changesets/action@'))!;
  const commands = steps
    .filter((step) => step.run?.includes('gh release'))
    .map((step) => step.run)
    .join('\n');
  const directory = await mkdtemp(join(tmpdir(), 'immutable-release-'));
  try {
    const names = ['cli-darwin-arm64', 'cli-darwin-x64', 'cli-linux-arm64', 'cli-linux-x64'].map(
      (pkg) => `${pkg}-1.2.3.tgz`,
    );
    for (const name of [...names, 'SHA256SUMS', 'RELEASE_NOTES.md']) await Bun.write(join(directory, name), 'fixture');
    const state = join(directory, 'state.json');
    await Bun.write(
      state,
      JSON.stringify({ published: changesets.with?.['create-github-releases'] !== false, assets: [] }),
    );
    await Bun.write(
      join(directory, 'gh'),
      `#!${process.execPath}
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { basename } = require('node:path');
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.RELEASE_TEST_STATE, 'utf8'));
if (state.published) { console.error('HTTP 422: Cannot upload assets to an immutable release.'); process.exit(1); }
if (args[0] !== 'release' || args[1] !== 'create') process.exit(2);
const files = args.filter(arg => arg.endsWith('.tgz') || basename(arg) === 'SHA256SUMS');
if (files.some(file => !existsSync(file))) process.exit(3);
const notes = args[args.indexOf('--notes-file') + 1];
if (!notes || !existsSync(notes) || !args.includes('--verify-tag')) process.exit(4);
writeFileSync(process.env.RELEASE_TEST_STATE, JSON.stringify({ published: !args.includes('--draft'), assets: files.map(file => basename(file)).sort() }));
`,
    );
    const chmod = Bun.spawn(['chmod', '+x', join(directory, 'gh')]);
    await chmod.exited;
    const child = Bun.spawn(['bash', '-e', '-c', commands], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        VERSION: '1.2.3',
        RELEASE_ASSETS_DIR: directory,
        RELEASE_TEST_STATE: state,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    expect(await Bun.file(state).json()).toEqual({ published: true, assets: [...names, 'SHA256SUMS'].sort() });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
