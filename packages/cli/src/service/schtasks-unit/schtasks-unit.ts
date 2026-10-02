import { win32 } from 'node:path';

import { isPlainObject } from 'es-toolkit/predicate';

import { type UnitOptions, unitEnv } from '../unit-templates';

export const TASK_FOLDER = '\\AIO Proxy\\';
export const taskPath = (sid: string): string => `${TASK_FOLDER}aio-proxy-${sid}`;

export type ServiceSpec = { readonly exec: string; readonly env: Readonly<Record<string, string>> };

export const serviceSpecPath = (localAppData: string): string => win32.join(localAppData, 'aio-proxy', 'service.json');
export const serviceStatePath = (localAppData: string): string =>
  win32.join(localAppData, 'aio-proxy', 'service.state.json');

export const renderServiceSpec = (o: UnitOptions): ServiceSpec => ({ exec: o.exec, env: unitEnv(o, win32.dirname) });

export function parseServiceSpec(text: string): ServiceSpec | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(value) || typeof value['exec'] !== 'string') return undefined;
  const env = value['env'];
  if (!isPlainObject(env) || !Object.values(env).every((v) => typeof v === 'string')) return undefined;
  return { exec: value['exec'], env: env as Record<string, string> };
}

/** The supervisor PID in `service.state.json`; undefined when the file does not hold one. */
export function parseServiceState(text: string): number | undefined {
  try {
    const state: unknown = JSON.parse(text);
    const pid = isPlainObject(state) ? state['pid'] : undefined;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

const TASK_NAMESPACE = 'http://schemas.microsoft.com/windows/2004/02/mit/task';
const COMMAND = 'conhost.exe';
// Windows paths cannot contain `"`, so quoting each path in plain double quotes is lossless.
const ARGUMENTS = /^--headless "([^"]+)" __service-run "([^"]+)"$/;

const text = (name: string, value: string): Bun.XML.NodeInput => ({ name, children: [value] });
const node = (name: string, children: Bun.XML.NodeInput[]): Bun.XML.NodeInput => ({ name, children });

export function renderTaskXml(o: { sid: string; exec: string; specPath: string }): string {
  if (o.exec.includes('"') || o.specPath.includes('"')) throw new Error('Windows paths cannot contain a double quote');
  const task: Bun.XML.NodeInput = {
    name: 'Task',
    attributes: { version: '1.2', xmlns: TASK_NAMESPACE },
    children: [
      node('Triggers', [node('LogonTrigger', [text('Enabled', 'true'), text('UserId', o.sid)])]),
      node('Principals', [
        {
          name: 'Principal',
          attributes: { id: 'Author' },
          children: [text('UserId', o.sid), text('LogonType', 'InteractiveToken'), text('RunLevel', 'LeastPrivilege')],
        },
      ]),
      node('Settings', [
        text('MultipleInstancesPolicy', 'IgnoreNew'),
        text('DisallowStartIfOnBatteries', 'false'),
        text('StopIfGoingOnBatteries', 'false'),
        text('Enabled', 'true'),
        text('ExecutionTimeLimit', 'PT0S'),
        node('RestartOnFailure', [text('Interval', 'PT1M'), text('Count', '3')]),
      ]),
      {
        name: 'Actions',
        attributes: { Context: 'Author' },
        children: [
          node('Exec', [
            text('Command', COMMAND),
            text('Arguments', `--headless "${o.exec}" __service-run "${o.specPath}"`),
          ]),
        ],
      },
    ],
  };
  return `<?xml version="1.0" encoding="UTF-16"?>\n${Bun.XML.stringify(task, null, 2)}\n`;
}

const child = (parent: unknown, key: string): unknown => (isPlainObject(parent) ? parent[key] : undefined);

export type ParsedTask = {
  /** The principal's `UserId`: a SID, or an account name once Task Scheduler has rewritten it. */
  readonly sid: string;
  /** The logon trigger's `UserId`, which Task Scheduler may spell differently from the principal. */
  readonly triggerUser: string | undefined;
  readonly exec: string;
  readonly specPath: string;
};

/**
 * Reads the action `renderTaskXml` writes; anything else (another command, extra arguments) is not ours.
 * Whose task it is, the caller judges from `sid` and `triggerUser`.
 */
export function parseTaskXml(xml: string): ParsedTask | undefined {
  let task: unknown;
  try {
    task = (Bun.XML.parse(xml) as Record<string, unknown>)['Task'];
  } catch {
    return undefined;
  }
  if (!isPlainObject(task) || task['@xmlns'] !== TASK_NAMESPACE) return undefined;
  const principal = child(child(task, 'Principals'), 'Principal');
  const sid = child(principal, 'UserId');
  const exec = child(child(task, 'Actions'), 'Exec');
  const args = child(exec, 'Arguments');
  const triggerUser = child(child(child(task, 'Triggers'), 'LogonTrigger'), 'UserId');
  if (typeof sid !== 'string' || (triggerUser !== undefined && typeof triggerUser !== 'string')) return undefined;
  if (child(exec, 'Command') !== COMMAND || typeof args !== 'string') return undefined;
  const match = ARGUMENTS.exec(args);
  return match === null ? undefined : { sid, triggerUser, exec: match[1]!, specPath: match[2]! };
}
