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
- Pull request titles use the same commitlint form as commits, e.g. `fix(core): restore session affinity fallback`.
- Describe the problem, solution, and verification results in the pull request.
- Keep each pull request focused on one clearly defined problem.
- Confirm that formatting, lint, and relevant tests pass before submission.

## Changesets

Releases are driven by [Changesets](https://github.com/changesets/changesets). If your change affects the published products, add a changeset in the same pull request:

```bash
bun changeset
```

- Target only the public product packages — `aio-proxy` (the CLI/proxy launcher) or `@aio-proxy/plugin-sdk`. A CI guard rejects changesets that target private or platform-binary packages.
- Write a short user-facing sentence. Do not prefix it with an area label (`core:`, `cli:`, plugin short name). Every package is version-bumped in lockstep, but only the public products get a `CHANGELOG.md` and a GitHub Release, so the note must live on one of them.
- Pick the bump level and write a short, user-facing summary. Commit the generated `.changeset/*.md` file with your change.
- Purely internal changes (refactors, tests, tooling) need no changeset.

You do not run `changeset version` or publish by hand. On merge to `main`, CI maintains a standing `chore: release` Version PR that consumes the accumulated changesets; merging that PR is what cuts a release.

## Canary releases

For a change that is large or hard to verify locally, publish a canary build and install it for real. Run the **Release** workflow manually (Actions → Release → Run workflow) and pick your branch. It publishes every package at `X.Y.(Z+1)-canary.<run_number>.g<sha7>` — where `X.Y.Z` is the current published release, not your branch's manifest version — to the npm `canary` dist-tag. Nothing else moves: no version commit, no git tag, no GitHub Release, no Docker image, no Homebrew notification, and the `latest` dist-tag is untouched.

```bash
# try it once
bunx aio-proxy@canary

# switch an existing install over (npm/bun/pnpm installs and standalone binaries)
aio-proxy upgrade --version 0.23.1-canary.4213.ga1b2c3d

# go back to the stable line
aio-proxy upgrade --force
```

A canary sorts above the last release and below the next one, so canary users are not prompted to "upgrade" backwards, and the next real release takes over on its own. Canary versions stay on npm permanently — that is expected, the `canary` dist-tag is just a pointer to the most recent one.

Homebrew installs cannot take a canary: the tap carries only released bottles, and `upgrade` hands Homebrew the formula rather than a version, so `--version` is ignored there. Test a canary from a `bunx` run or a non-Homebrew install instead.

Dispatching the workflow runs that branch's own `scripts/release.ts` with publish credentials, so a canary is only as trustworthy as the branch it came from. Anyone who can dispatch the workflow can publish — treat write access to this repository as publish access.
