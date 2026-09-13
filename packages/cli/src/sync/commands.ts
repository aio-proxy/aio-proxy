import { m } from '@aio-proxy/i18n';
import type { SyncPreviewInput } from '@aio-proxy/types';
import { SyncApplyInputSchema, SyncPreviewInputSchema } from '@aio-proxy/types';
import type { Command } from 'commander';

import { createSyncClient, readJsonFile, SyncCliError, type SyncCliDeps } from './client';
import { renderSyncPreview, renderSyncStatus } from './output';

type OutputOptions = { readonly json?: boolean };

const isJson = (options: OutputOptions, command: Command): boolean =>
  options.json === true || command.parent?.opts()['json'] === true;

function parsePreviewInput(input: unknown): SyncPreviewInput {
  const parsed = SyncPreviewInputSchema.safeParse(input);
  if (!parsed.success) throw new SyncCliError('invalid-request', m['cli.sync.invalid_request']());
  return parsed.data;
}

export function registerSyncCommands(program: Command, deps: SyncCliDeps): void {
  const client = createSyncClient(deps);
  const sync = program
    .command('sync')
    .description(m['cli.sync.description']())
    .option('--json', m['cli.sync.option_json']())
    .option('--password-stdin', m['cli.sync.option_password_stdin']());
  const emitStatus = (status: Awaited<ReturnType<typeof client.status>>, options: OutputOptions, command: Command) =>
    deps.write(renderSyncStatus(status, isJson(options, command)));
  const emitPreview = (preview: Awaited<ReturnType<typeof client.preview>>, options: OutputOptions, command: Command) =>
    deps.write(renderSyncPreview(preview, isJson(options, command)));

  sync
    .command('status')
    .description(m['cli.sync.status_description']())
    .option('--json', m['cli.sync.option_json']())
    .action(async (options: OutputOptions, command: Command) => emitStatus(await client.status(), options, command));

  sync
    .command('connect')
    .description(m['cli.sync.connect_description']())
    .requiredOption('--plugin <package>', m['cli.sync.option_plugin']())
    .requiredOption('--capability <id>', m['cli.sync.option_capability']())
    .requiredOption('--options-file <path>', m['cli.sync.option_options_file']())
    .option('--json', m['cli.sync.option_json']())
    .action(
      async (
        options: { plugin: string; capability: string; optionsFile: string } & OutputOptions,
        command: Command,
      ) => {
        const input = parsePreviewInput({
          kind: 'connect',
          plugin: options.plugin,
          capability: options.capability,
          options: await readJsonFile(options.optionsFile),
        });
        emitPreview(await client.preview(input), options, command);
      },
    );

  sync
    .command('join <providerId>')
    .description(m['cli.sync.join_description']())
    .option('--json', m['cli.sync.option_json']())
    .action(async (providerId: string, options: OutputOptions, command: Command) => {
      emitPreview(await client.preview(parsePreviewInput({ kind: 'join', providerId })), options, command);
    });

  sync
    .command('leave <providerId>')
    .description(m['cli.sync.leave_description']())
    .option('--json', m['cli.sync.option_json']())
    .action(async (providerId: string, options: OutputOptions, command: Command) => {
      emitStatus(await client.range(providerId), options, command);
    });

  sync
    .command('apply <previewId>')
    .description(m['cli.sync.apply_description']())
    .requiredOption('--decisions-file <path>', m['cli.sync.option_decisions_file']())
    .option('--json', m['cli.sync.option_json']())
    .action(async (previewId: string, options: { decisionsFile: string } & OutputOptions, command: Command) => {
      const decisions = await readJsonFile(options.decisionsFile);
      const parsed = SyncApplyInputSchema.safeParse({ previewId, decisions });
      if (!parsed.success)
        throw new SyncCliError('invalid-file', m['cli.sync.invalid_file']({ path: options.decisionsFile }));
      emitStatus(await client.apply(parsed.data), options, command);
    });

  sync
    .command('history <objectId>')
    .description(m['cli.sync.history_description']())
    .option('--json', m['cli.sync.option_json']())
    .action(async (objectId: string, options: OutputOptions, command: Command) => {
      const history = await client.history(objectId);
      deps.write(
        isJson(options, command) ? JSON.stringify(history) : history.map((item) => JSON.stringify(item)).join('\n'),
      );
    });

  sync
    .command('restore <objectId> <operationId>')
    .description(m['cli.sync.restore_description']())
    .option('--json', m['cli.sync.option_json']())
    .action(async (objectId: string, operationId: string, options: OutputOptions, command: Command) => {
      emitPreview(
        await client.preview(parsePreviewInput({ kind: 'restore', objectId, operationId })),
        options,
        command,
      );
    });

  sync
    .command('overrides <objectId>')
    .description(m['cli.sync.overrides_description']())
    .requiredOption('--paths-file <path>', m['cli.sync.option_paths_file']())
    .option('--json', m['cli.sync.option_json']())
    .action(async (objectId: string, options: { pathsFile: string } & OutputOptions, command: Command) => {
      const paths = await readJsonFile(options.pathsFile);
      emitPreview(await client.preview(parsePreviewInput({ kind: 'overrides', objectId, paths })), options, command);
    });

  sync
    .command('purge')
    .description(m['cli.sync.purge_description']())
    .option('--provider <providerId>', m['cli.sync.option_provider']())
    .option('--plugin <package>', m['cli.sync.option_plugin']())
    .option('--json', m['cli.sync.option_json']())
    .action(async (options: { provider?: string; plugin?: string } & OutputOptions, command: Command) => {
      if ((options.provider === undefined) === (options.plugin === undefined))
        throw new SyncCliError('invalid-request', m['cli.sync.purge_scope_required']());
      const input = parsePreviewInput({
        kind: 'purge',
        scope: options.provider === undefined ? 'plugin' : 'provider',
        objectId: options.provider ?? options.plugin!,
      });
      emitPreview(await client.preview(input), options, command);
    });

  sync
    .command('detach <providerId>')
    .description(m['cli.sync.detach_description']())
    .option('--json', m['cli.sync.option_json']())
    .action(async (providerId: string, options: OutputOptions, command: Command) => {
      const loginSessionId = await client.startDetachSession(providerId);
      emitStatus(await client.detach(providerId, loginSessionId), options, command);
    });

  sync
    .command('detach-cancel <providerId>')
    .description(m['cli.sync.detach_cancel_description']())
    .option('--json', m['cli.sync.option_json']())
    .action(async (providerId: string, options: OutputOptions, command: Command) => {
      emitStatus(await client.cancelDetach(providerId), options, command);
    });

  sync
    .command('retry')
    .description(m['cli.sync.retry_description']())
    .option('--json', m['cli.sync.option_json']())
    .action(async (options: OutputOptions, command: Command) => emitStatus(await client.retry(), options, command));

  sync
    .command('disconnect')
    .description(m['cli.sync.disconnect_description']())
    .option('--json', m['cli.sync.option_json']())
    .action(async (options: OutputOptions, command: Command) =>
      emitStatus(await client.disconnect(), options, command),
    );
}
