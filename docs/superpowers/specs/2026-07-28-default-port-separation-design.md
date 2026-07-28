# Default Port Separation Design

## Goal

Use port `9317` for end-user defaults while keeping local development on port `22078`, supplied by the root development command.

## Design

- Change user-facing defaults to `9317`: generated configuration, CLI fallback, runtime schema default, server default, and provider-command Dashboard URL.
- Set `AIO_PROXY_PORT=22078` in the root `dev` command.
- Declare `AIO_PROXY_PORT` for Turbo's `dev` and `serve:dev` tasks so both child processes receive it.
- Pass the variable to the development CLI through `--port` and use it for the Dashboard development proxy target and Origin.
- Let the Dashboard proxy fall back to `9317` outside the root development command so build and standalone configuration loading do not require the development-only variable.

## Existing Configurations

Existing user configuration files are not migrated or rewritten. Explicit `--port` values continue to override the default.

## Testing

- Assert that a newly bootstrapped configuration contains port `9317`.
- Update existing behavior-level assertions for schema and server defaults.
- Keep integration tests on dynamically allocated ports or their existing explicit fixture ports.
- Verify the development scripts and Dashboard proxy use `AIO_PROXY_PORT` without adding tests that merely restate package-script literals.

## Non-goals

- Do not rewrite historical plans or specifications that mention `22078`.
- Do not centralize the numeric default behind a new cross-package abstraction.
- Do not change the Dashboard development server port `3000`.
