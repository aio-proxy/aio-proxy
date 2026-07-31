# Contributing

Contributions to AIO Proxy are welcome, including bug reports, documentation improvements, and code changes.

## Requirements

- Git
- Bun 1.3.14 or later

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
