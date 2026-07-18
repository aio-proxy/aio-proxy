import { expect, test } from "bun:test";

interface DryRunTask {
  taskId: string;
  command: string;
  resolvedTaskDefinition: {
    persistent: boolean;
  };
}

const dryRun = (...args: string[]): DryRunTask[] => {
  const result = Bun.spawnSync([process.execPath, "x", "turbo", "run", ...args, "--dry=json"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) throw new Error(result.stderr.toString());
  return (JSON.parse(result.stdout.toString()) as { tasks: DryRunTask[] }).tasks;
};

test("development task graph separates builds from persistent watchers", async () => {
  const { scripts } = (await Bun.file(`${import.meta.dir}/package.json`).json()) as {
    scripts: Record<string, string>;
  };
  expect(scripts["dev:prepare"]).toBe("turbo run build --filter=@aio-proxy/core");
  expect(scripts.dev).toBe("bun run dev:prepare && turbo run dev serve:dev --filter=!@aio-proxy/infra");

  const prepareTaskIds = dryRun("build", "--filter=@aio-proxy/core").map(({ taskId }) => taskId);
  for (const taskId of [
    "@aio-proxy/types#build",
    "@aio-proxy/plugin-sdk#build",
    "@aio-proxy/plugin-github-copilot#build",
    "@aio-proxy/plugin-openai-chatgpt#build",
    "@aio-proxy/core#build",
  ]) {
    expect(prepareTaskIds).toContain(taskId);
  }

  const persistentTasks = dryRun("dev", "serve:dev", "--filter=!@aio-proxy/infra").filter(
    ({ command }) => command !== "<NONEXISTENT>",
  );
  const persistentTaskIds = persistentTasks.map(({ taskId }) => taskId);
  expect(persistentTaskIds.filter((taskId) => taskId.endsWith("#build"))).toEqual([]);
  for (const taskId of [
    "@aio-proxy/types#dev",
    "@aio-proxy/plugin-sdk#dev",
    "@aio-proxy/plugin-github-copilot#dev",
    "@aio-proxy/plugin-openai-chatgpt#dev",
    "@aio-proxy/core#dev",
    "@aio-proxy/i18n#dev",
    "@aio-proxy/dashboard#dev",
    "@aio-proxy/cli#serve:dev",
  ]) {
    expect(persistentTaskIds).toContain(taskId);
    expect(persistentTasks.find((task) => task.taskId === taskId)?.resolvedTaskDefinition.persistent).toBe(true);
  }
});
