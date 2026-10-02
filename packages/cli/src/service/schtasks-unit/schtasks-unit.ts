import { win32 } from 'node:path';

import { isPlainObject } from 'es-toolkit/predicate';

import { type UnitOptions, unitEnv } from '../unit-templates';

export const TASK_FOLDER = '\\AIO Proxy\\';
export const taskPath = (sid: string): string => `${TASK_FOLDER}aio-proxy-${sid}`;

export type ServiceSpec = { readonly exec: string; readonly env: Readonly<Record<string, string>> };

export const serviceSpecPath = (localAppData: string): string => win32.join(localAppData, 'aio-proxy', 'service.json');
/** `service.state.json` beside a spec file, in that path's own separators: `__service-run` knows only the spec path. */
export const serviceStatePathBeside = (specPath: string): string => specPath.replace(/[^\\/]*$/u, 'service.state.json');
export const serviceStatePath = (localAppData: string): string => serviceStatePathBeside(serviceSpecPath(localAppData));

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
  /** `Settings/Enabled`, what `/Change /DISABLE` flips; ASCII, so unlike the localized `/V` status it reads
   * the same through any encoding. Absent means enabled. */
  readonly enabled: boolean;
  /** The `<exec> __service-run <spec>` action `renderTaskXml` writes; undefined for any other action. */
  readonly action: { readonly exec: string; readonly specPath: string } | undefined;
};

/** A task in our namespace with a principal; whose it is, `isOwnTask` judges. */
export function parseTaskXml(xml: string): ParsedTask | undefined {
  let task: unknown;
  try {
    task = (Bun.XML.parse(xml) as Record<string, unknown>)['Task'];
  } catch {
    return undefined;
  }
  if (!isPlainObject(task) || task['@xmlns'] !== TASK_NAMESPACE) return undefined;
  const sid = child(child(child(task, 'Principals'), 'Principal'), 'UserId');
  const triggerUser = child(child(child(task, 'Triggers'), 'LogonTrigger'), 'UserId');
  if (typeof sid !== 'string' || (triggerUser !== undefined && typeof triggerUser !== 'string')) return undefined;
  const settings = child(task, 'Settings');
  const enabled = isPlainObject(settings) && (settings['Enabled'] === undefined || settings['Enabled'] === 'true');
  const exec = child(child(task, 'Actions'), 'Exec');
  const args = child(exec, 'Arguments');
  const match = child(exec, 'Command') === COMMAND && typeof args === 'string' ? ARGUMENTS.exec(args) : null;
  return { sid, triggerUser, enabled, action: match === null ? undefined : { exec: match[1]!, specPath: match[2]! } };
}

/** The current Windows user, as Task Scheduler may name it: by SID or by `DOMAIN\user`. */
export type WindowsUser = { readonly sid: string; readonly account: string };

// `schtasks /Query /XML` output reaches us in an unverified encoding, so non-ASCII text from it may come
// back mangled (U+FFFD or another code page). Only its ASCII characters are compared.
export const asciiFolded = (text: string): string => text.replace(/[\u0080-\u{10FFFF}]/gu, '').toLowerCase();

/** Whether the task runs as `user`: its principal and, when present, its logon trigger name them. */
export function isOwnTask(task: ParsedTask | undefined, user: WindowsUser): boolean {
  // The SID match is the trust boundary; the ASCII-folded account match only tolerates a mangled name.
  const isUser = (id: string) => id === user.sid || asciiFolded(id) === asciiFolded(user.account);
  return task !== undefined && isUser(task.sid) && (task.triggerUser === undefined || isUser(task.triggerUser));
}
