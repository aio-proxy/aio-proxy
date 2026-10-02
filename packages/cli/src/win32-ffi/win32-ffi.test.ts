import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { processImagePath } from './win32-ffi';

const onlyOnWindows = test.skipIf(process.platform !== 'win32');

onlyOnWindows('processImagePath reads the full executable path of a running process', () => {
  expect(processImagePath(process.pid)?.toLowerCase()).toBe(process.execPath.toLowerCase());
});

onlyOnWindows('killing the job owner ends the processes assigned to its kill-on-close job', async () => {
  // The child is detached so libuv does not put it in its own kill-on-close job; only ours can end it.
  const moduleUrl = pathToFileURL(join(import.meta.dir, 'win32-ffi.ts')).href;
  const owner = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { assignToJob, createKillOnCloseJob } from ${JSON.stringify(moduleUrl)};
       const job = createKillOnCloseJob();
       const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, detached: true });
       assignToJob(job, child.pid);
       console.log(child.pid);
       setInterval(() => {}, 1000);`,
    ],
    { stdout: 'pipe', stderr: 'inherit', windowsHide: true },
  );
  const reader = owner.stdout.getReader();
  let out = '';
  while (!out.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  const childPid = Number(out.trim());
  try {
    expect(processImagePath(childPid)).toBeDefined();
    owner.kill();
    await owner.exited;
    const deadline = Date.now() + 5000;
    while (processImagePath(childPid) !== undefined && Date.now() < deadline) await Bun.sleep(100);
    expect(processImagePath(childPid)).toBeUndefined();
  } finally {
    owner.kill();
    try {
      process.kill(childPid);
    } catch {}
  }
});
