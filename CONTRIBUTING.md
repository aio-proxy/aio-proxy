# Contributing

Contributions to AIO Proxy are welcome, including bug reports, documentation improvements, and code changes.

## Requirements

- Git
- Bun 1.4.2 or later.

## Set up the development environment

```bash
git clone https://github.com/aio-proxy/aio-proxy.git
cd aio-proxy
bun install
```

Start the development environment:

```bash
bun run dev
```

The project is a Bun workspace monorepo managed by Turborepo. Most source code lives in `packages/`.

## Development guidelines

- Keep changes focused and avoid unrelated refactoring.
- Reuse existing implementations; prefer the project's existing dependencies for generic utilities.
- Add the smallest meaningful automated test for non-trivial behavior changes.
- Use the project terms **Provider ID** and **Provider weight**.
- Keep tests next to their source and focus them on user-visible behavior or concrete regressions.

## Checks

Run the complete check before submitting a change:

```bash
bun run preflight
```

For faster feedback during development, run:

```bash
bun run check
bun run test:unit
```

When changing only part of the workspace, also run the tests for each affected package.

## Commits and pull requests

- Use Conventional Commits, such as `feat: ...`, `fix: ...`, or `docs: ...`.
- Describe the problem, solution, and verification results in the pull request.
- Keep each pull request focused on one clearly defined problem.
- Confirm that formatting, lint, and relevant tests pass before submission.

## Changesets

Releases are driven by [Changesets](https://github.com/changesets/changesets). If your change affects the published products, add a changeset in the same pull request:

```bash
bun changeset
```

- Target only the public product packages — `aio-proxy` (the CLI/proxy launcher) or `@aio-proxy/plugin-sdk`. A CI guard rejects changesets that target private or platform-binary packages.
- Put the affected internal area in the summary text, e.g. `core: fix provider fallback`. Every package is version-bumped in lockstep, but only the public products get a `CHANGELOG.md` and a GitHub Release, so the note must live on one of them.
- Pick the bump level and write a short, user-facing summary. Commit the generated `.changeset/*.md` file with your change.
- Purely internal changes (refactors, tests, tooling) need no changeset.

You do not run `changeset version` or publish by hand. On merge to `main`, CI maintains a standing `chore: release` Version PR that consumes the accumulated changesets; merging that PR is what cuts a release.
