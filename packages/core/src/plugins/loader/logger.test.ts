import type { Logger } from "@aio-proxy/plugin-sdk";

import { configureLogging } from "@aio-proxy/logger";
import { spyOn } from "bun:test";

import type { PluginLoggerFactory } from "../registry";

import {
  expect,
  install,
  loadPluginRegistry,
  options,
  PLUGIN_DESCRIPTOR_BRAND,
  test,
  zod,
  type PluginDescriptor,
} from "./test-support";

type CompatibleTestDescriptor<Options> = Omit<PluginDescriptor<Options>, "apiVersion"> & {
  readonly apiVersion: 1 | 2;
};

test("setup receives a redacting plugin logger for API v1 and v2", async () => {
  for (const apiVersion of [1, 2] as const) {
    const packageName = `@example/logger-v${apiVersion}`;
    const secret = `private-v${apiVersion}`;
    const records: { readonly category: readonly string[]; readonly payload: string }[] = [];
    const factoryOptions: (readonly string[] | undefined)[] = [];
    const createPluginLogger: PluginLoggerFactory = (category, loggerOptions = {}) => {
      const secrets = loggerOptions.redactSecretValues;
      factoryOptions.push(secrets);
      const capture: Logger["info"] = (messageOrProps, propsOrMessage) => {
        const payload = JSON.stringify([messageOrProps, propsOrMessage]);
        records.push({
          category: [...category],
          payload: (secrets ?? []).reduce(
            (redacted, value) => (value.length === 0 ? redacted : redacted.replaceAll(value, "[REDACTED]")),
            payload,
          ),
        });
      };
      const logger: Logger = {
        debug: capture,
        info: capture,
        warn: capture,
        error: capture,
        child: () => logger,
      };
      return logger;
    };
    const descriptor: CompatibleTestDescriptor<{ token: string }> = {
      [PLUGIN_DESCRIPTOR_BRAND]: true,
      apiVersion,
      metadata: {
        options: {
          schema: zod.object({ token: zod.string() }),
          form: [{ type: "secret", key: "token", label: "Token" }],
        },
      },
      setup(api, pluginOptions) {
        expect(api.logger).toBeDefined();
        expect(pluginOptions.token).toBe(secret);
        api.logger.info(`using ${secret}`, { token: secret });
      },
    };
    install(packageName);

    const snapshot = await loadPluginRegistry(
      options({
        enablements: [{ packageName }],
        importPackage: async () => ({ default: descriptor }),
        secrets: { readPluginSecret: () => ({ token: secret }) },
        createPluginLogger,
      }),
    );

    expect(snapshot.plugins.get(packageName)?.state.status).toBe("ready");
    expect(factoryOptions).toEqual([[secret]]);
    expect(records).toEqual([
      {
        category: ["aio-proxy", "plugin", packageName],
        payload: JSON.stringify(["using [REDACTED]", { token: "[REDACTED]" }]),
      },
    ]);
    expect(JSON.stringify(records)).not.toContain(secret);
  }
});

test("default plugin logger redacts setup logs for API v1 and v2", async () => {
  const calls: unknown[][] = [];
  const error = spyOn(console, "error").mockImplementation((...args) => {
    calls.push(args);
  });

  try {
    await configureLogging({ dir: "/unused/when-disabled" });
    for (const apiVersion of [1, 2] as const) {
      const packageName = `@example/default-logger-v${apiVersion}`;
      const secret = `production-private-v${apiVersion}`;
      const descriptor: CompatibleTestDescriptor<{ token: string }> = {
        [PLUGIN_DESCRIPTOR_BRAND]: true,
        apiVersion,
        metadata: {
          options: {
            schema: zod.object({ token: zod.string() }),
            form: [{ type: "secret", key: "token", label: "Token" }],
          },
        },
        setup(api, pluginOptions) {
          const circular: Record<string, unknown> = { token: pluginOptions.token };
          circular.self = circular;
          expect(() =>
            api.logger.info(`using ${pluginOptions.token}`, {
              token: pluginOptions.token,
              error: new Error(`failed with ${pluginOptions.token}`),
              circular,
            }),
          ).not.toThrow();
        },
      };
      install(packageName);

      const snapshot = await loadPluginRegistry(
        options({
          enablements: [{ packageName }],
          importPackage: async () => ({ default: descriptor }),
          secrets: { readPluginSecret: () => ({ token: secret }) },
        }),
      );

      expect(snapshot.plugins.get(packageName)?.state.status).toBe("ready");
    }

    const pluginCalls = calls.filter((call) => Bun.inspect(call).includes("@example/default-logger-v"));
    const captured = Bun.inspect(pluginCalls);
    expect(pluginCalls).toHaveLength(2);
    expect(captured).toContain("aio-proxy");
    expect(captured).toContain("plugin");
    expect(captured).toContain("@example/default-logger-v1");
    expect(captured).toContain("@example/default-logger-v2");
    expect(captured).toContain("[REDACTED]");
    expect(captured).not.toContain("production-private-v1");
    expect(captured).not.toContain("production-private-v2");
  } finally {
    error.mockRestore();
  }
});
