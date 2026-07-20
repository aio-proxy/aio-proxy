import { AtomicConfigFile } from "@aio-proxy/core";
import { isPlainObject } from "es-toolkit/predicate";

const ARGON2ID_PREFIX = "$argon2id$";
const ARGON2ID_PATTERN =
  /^\$argon2id\$v=19\$m=(?<memory>\d+),t=(?<time>\d+),p=(?<parallelism>\d+)\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/u;
const ARGON2ID_LIMITS = {
  memory: { min: 19_456, max: 262_144 },
  parallelism: { min: 1, max: 4 },
  time: { min: 2, max: 10 },
} as const;

export async function normalizeDashboardPassword<T extends Record<string, unknown>>(config: T): Promise<T> {
  const server = config["server"];
  if (!isPlainObject(server)) return config;
  const password = server["password"];
  if (typeof password !== "string") return config;
  if (password === "") throw new Error("Dashboard password must not be empty");

  if (password.startsWith(ARGON2ID_PREFIX)) {
    if (!validArgon2idHash(password)) throw new Error("Invalid Argon2id password hash");
    try {
      await Bun.password.verify("aio-proxy-dashboard-probe", password);
    } catch {
      throw new Error("Invalid Argon2id password hash");
    }
    return config;
  }

  return {
    ...config,
    server: { ...server, password: await Bun.password.hash(password) },
  };
}

function validArgon2idHash(hash: string): boolean {
  const parameters = ARGON2ID_PATTERN.exec(hash)?.groups;
  if (parameters === undefined) return false;
  return Object.entries(ARGON2ID_LIMITS).every(([name, limits]) => {
    const value = Number(parameters[name]);
    return Number.isSafeInteger(value) && value >= limits.min && value <= limits.max;
  });
}

export async function normalizeDashboardPasswordFile(file: AtomicConfigFile): Promise<Record<string, unknown>> {
  return file.transaction(async (current) => {
    const next = await normalizeDashboardPassword(current);
    return { next, result: next };
  });
}

export async function prepareDashboardConfig(
  config: unknown,
  configPath: string | undefined,
): Promise<{ readonly config: unknown; readonly dashboardUnavailable: boolean; readonly error?: unknown }> {
  try {
    const normalized =
      configPath === undefined
        ? isPlainObject(config)
          ? await normalizeDashboardPassword(config)
          : config
        : await normalizeDashboardPasswordFile(new AtomicConfigFile(configPath));
    return { config: normalized, dashboardUnavailable: false };
  } catch (error) {
    return { config: withoutDashboardPassword(config), dashboardUnavailable: true, error };
  }
}

function withoutDashboardPassword(config: unknown): unknown {
  if (!isPlainObject(config) || !isPlainObject(config["server"])) return config;
  const { password: _password, ...server } = config["server"];
  return { ...config, server };
}
