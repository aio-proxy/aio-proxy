import {
  type DashboardPluginOptionsMutation,
  type DashboardPluginOptionsMutationInput,
  DashboardPluginOptionsMutationSchema,
  PluginPackageNameSchema,
} from '@aio-proxy/types';
import type { Context } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';

import { PluginControlPlaneError, PluginDependenciesError } from '../../plugin-control-plane';
import type { ServerState } from '../../server-state';

const PluginEditQuerySchema = z.strictObject({ packageName: PluginPackageNameSchema });
const PluginInstallRequestSchema = z.strictObject({
  packageName: PluginPackageNameSchema,
  registry: z.url().optional(),
  confirmed: z.boolean().optional(),
});
const PluginUninstallRequestSchema = z.strictObject({ packageName: PluginPackageNameSchema });

const editQueryValidator = validator('query', (raw, context) => {
  const parsed = PluginEditQuerySchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: { code: 'invalid_request' }, ok: false } as const, 400);
}) as unknown as MiddlewareHandler<
  Record<string, never>,
  string,
  {
    in: { query: z.input<typeof PluginEditQuerySchema> };
    out: { query: z.output<typeof PluginEditQuerySchema> };
  }
>;

const optionsValidator = validator('json', (raw, context) => {
  const parsed = DashboardPluginOptionsMutationSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: { code: 'options_invalid' }, ok: false } as const, 422);
}) as unknown as MiddlewareHandler<
  Record<string, never>,
  string,
  {
    in: { json: DashboardPluginOptionsMutationInput };
    out: { json: DashboardPluginOptionsMutation };
  }
>;

const installValidator = validator('json', (raw, context) => {
  const parsed = PluginInstallRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: { code: 'invalid_request' }, ok: false } as const, 400);
}) as unknown as MiddlewareHandler<
  Record<string, never>,
  string,
  {
    in: { json: z.input<typeof PluginInstallRequestSchema> };
    out: { json: z.output<typeof PluginInstallRequestSchema> };
  }
>;

const uninstallValidator = validator('json', (raw, context) => {
  const parsed = PluginUninstallRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: { code: 'invalid_request' }, ok: false } as const, 400);
}) as unknown as MiddlewareHandler<
  Record<string, never>,
  string,
  {
    in: { json: z.input<typeof PluginUninstallRequestSchema> };
    out: { json: z.output<typeof PluginUninstallRequestSchema> };
  }
>;

const controlPlaneError = (context: Context, error: unknown) => {
  if (error instanceof PluginDependenciesError) {
    return context.json(
      { error: { code: error.code, providerIds: error.providerIds }, ok: false } as const,
      error.status,
    );
  }
  if (error instanceof PluginControlPlaneError) {
    return context.json({ error: { code: error.code }, ok: false } as const, error.status);
  }
  throw error;
};

export const createDashboardPluginRoutes = (state: ServerState) =>
  new Hono()
    .get('/', (context) => context.json({ plugins: state.pluginControlPlane.summaries() }))
    .get('/edit-view', editQueryValidator, async (context) => {
      try {
        return context.json(await state.pluginControlPlane.editView(context.req.valid('query').packageName));
      } catch (error) {
        return controlPlaneError(context, error);
      }
    })
    .put('/options', optionsValidator, async (context) => {
      try {
        const plugin = await state.pluginControlPlane.updateOptions(context.req.valid('json'));
        return context.json({ ok: true, plugin } as const);
      } catch (error) {
        return controlPlaneError(context, error);
      }
    })
    .post('/install', installValidator, async (context) => {
      try {
        const input = context.req.valid('json');
        await state.pluginControlPlane.install(input);
        return context.json({ ok: true, packageName: input.packageName } as const, 201);
      } catch (error) {
        return controlPlaneError(context, error);
      }
    })
    .delete('/uninstall', uninstallValidator, async (context) => {
      try {
        const { packageName } = context.req.valid('json');
        await state.pluginControlPlane.uninstall(packageName);
        return context.json({ ok: true, packageName } as const);
      } catch (error) {
        return controlPlaneError(context, error);
      }
    });
