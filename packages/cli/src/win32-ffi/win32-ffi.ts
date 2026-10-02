import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from 'bun:ffi';

// Every function loads kernel32 on first use, so importing this module on macOS/Linux never calls dlopen.
const loadKernel32 = () =>
  dlopen('kernel32.dll', {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    QueryFullProcessImageNameW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
    lstrlenW: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
let kernel32Symbols: ReturnType<typeof loadKernel32> | undefined;
const kernel32 = () => (kernel32Symbols ??= loadKernel32());

const loadAdvapi32 = () =>
  dlopen('advapi32.dll', {
    OpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    GetTokenInformation: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    ConvertSidToStringSidW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    ConvertStringSidToSidW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    LookupAccountSidW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  }).symbols;
let advapi32Symbols: ReturnType<typeof loadAdvapi32> | undefined;
const advapi32 = () => (advapi32Symbols ??= loadAdvapi32());

// bun:ffi types a returned pointer as `Pointer | bigint`; either form is accepted back as a pointer argument.
export type JobHandle = Pointer | bigint;

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
// JOBOBJECT_EXTENDED_LIMIT_INFORMATION per winnt.h (Windows SDK) on x64: BasicLimitInformation is two
// LARGE_INTEGERs (0, 8) then DWORD LimitFlags (16), padded to 64 bytes in all; IO_COUNTERS (6 x ULONGLONG,
// 64..112); four SIZE_T memory fields (112..144). Total 144 bytes.
const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x0008;
const TOKEN_USER_CLASS = 1;
// Windows extended-length paths top out at 32,767 UTF-16 units.
const MAX_IMAGE_PATH_CHARS = 32_768;

/**
 * A job that terminates every process in it once its last handle closes, i.e. when the owning process
 * dies. The caller keeps the handle open for its whole lifetime; that is what makes kill-on-close mean
 * "dies with me".
 */
export function createKillOnCloseJob(): JobHandle {
  const k = kernel32();
  const job = k.CreateJobObjectW(null, null);
  if (job === null) throw new Error('CreateJobObjectW failed');
  const info = new Uint8Array(EXTENDED_LIMIT_INFORMATION_SIZE);
  new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  if (k.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, info, info.byteLength) === 0) {
    k.CloseHandle(job);
    throw new Error('SetInformationJobObject failed');
  }
  return job;
}

export function assignToJob(job: JobHandle, pid: number): void {
  const k = kernel32();
  const proc = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
  if (proc === null) throw new Error(`OpenProcess(${pid}) failed`);
  try {
    if (k.AssignProcessToJobObject(job, proc) === 0) throw new Error(`AssignProcessToJobObject(${pid}) failed`);
  } finally {
    k.CloseHandle(proc);
  }
}

/** The full Win32 path of `pid`'s executable, or `undefined` when it cannot be read (gone, denied, not win32). */
export function processImagePath(pid: number): string | undefined {
  try {
    const k = kernel32();
    const proc = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (proc === null) return undefined;
    try {
      const buffer = new Uint16Array(MAX_IMAGE_PATH_CHARS);
      const size = new Uint32Array([buffer.length]);
      if (k.QueryFullProcessImageNameW(proc, 0, buffer, size) === 0) return undefined;
      return new TextDecoder('utf-16le').decode(buffer.subarray(0, size[0]));
    } finally {
      k.CloseHandle(proc);
    }
  } catch {
    return undefined;
  }
}

/**
 * The string SID (`S-1-5-21-…`) of the account `pid` runs as, or `undefined` when it cannot be read (gone,
 * denied, not win32). A SID, unlike an account name printed by a console tool, survives every code page.
 */
export function processUserSid(pid: number): string | undefined {
  try {
    const k = kernel32();
    const proc = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (proc === null) return undefined;
    try {
      return tokenUserSid(proc);
    } finally {
      k.CloseHandle(proc);
    }
  } catch {
    return undefined;
  }
}

/** This process's own account SID; `undefined` when it cannot be read. */
export const currentUserSid = (): string | undefined => processUserSid(process.pid);

/**
 * `DOMAIN\name` for a string SID, read in UTF-16 so a non-ASCII account survives (console tools print it in
 * the console code page); `undefined` when it cannot be resolved or not on win32.
 */
export function accountForSid(sid: string): string | undefined {
  try {
    const k = kernel32();
    const a = advapi32();
    const sidOut = new BigUint64Array(1);
    if (a.ConvertStringSidToSidW(Buffer.from(`${sid}\0`, 'utf16le'), sidOut) === 0 || sidOut[0] === 0n)
      return undefined;
    const psid = sidOut[0]!;
    try {
      // The first call fails with ERROR_INSUFFICIENT_BUFFER and reports both lengths, terminators included.
      const nameLength = new Uint32Array(1);
      const domainLength = new Uint32Array(1);
      const use = new Uint32Array(1);
      a.LookupAccountSidW(null, psid, null, nameLength, null, domainLength, use);
      if (!nameLength[0] || !domainLength[0]) return undefined;
      const name = new Uint16Array(nameLength[0]);
      const domain = new Uint16Array(domainLength[0]);
      if (a.LookupAccountSidW(null, psid, name, nameLength, domain, domainLength, use) === 0) return undefined;
      // On success the lengths exclude the terminator.
      const decode = (buffer: Uint16Array, length: number | undefined) =>
        new TextDecoder('utf-16le').decode(buffer.subarray(0, length));
      const account = decode(name, nameLength[0]);
      const domainName = decode(domain, domainLength[0]);
      if (account === '') return undefined;
      return domainName === '' ? account : `${domainName}\\${account}`;
    } finally {
      k.LocalFree(psid);
    }
  } catch {
    return undefined;
  }
}

function tokenUserSid(proc: Pointer | bigint): string | undefined {
  const k = kernel32();
  const a = advapi32();
  const tokenOut = new BigUint64Array(1);
  if (a.OpenProcessToken(proc, TOKEN_QUERY, tokenOut) === 0 || tokenOut[0] === 0n) return undefined;
  const token = tokenOut[0]!;
  try {
    // The first call fails with ERROR_INSUFFICIENT_BUFFER and reports the size TOKEN_USER needs.
    const size = new Uint32Array(1);
    a.GetTokenInformation(token, TOKEN_USER_CLASS, null, 0, size);
    if (size[0] === undefined || size[0] < 16) return undefined;
    // TOKEN_USER (winnt.h) on x64 is SID_AND_ATTRIBUTES: PSID at 0, DWORD Attributes at 8; the SID it points
    // at lives later in the same buffer. 8-byte elements keep that pointer aligned.
    const info = new BigUint64Array(Math.ceil(size[0] / 8));
    if (a.GetTokenInformation(token, TOKEN_USER_CLASS, info, info.byteLength, size) === 0) return undefined;
    const sid = info[0] ?? 0n;
    const base = BigInt(ptr(info));
    // Anything but a pointer into our own buffer means the layout is not what we read it as.
    if (sid < base || sid >= base + BigInt(info.byteLength)) return undefined;
    const textOut = new BigUint64Array(1);
    if (a.ConvertSidToStringSidW(sid, textOut) === 0 || textOut[0] === 0n) return undefined;
    const text = textOut[0]!;
    try {
      const length = k.lstrlenW(text);
      if (length <= 0) return undefined;
      const value = new TextDecoder('utf-16le').decode(toArrayBuffer(text, 0, length * 2));
      return value.startsWith('S-1-') ? value : undefined;
    } finally {
      k.LocalFree(text);
    }
  } finally {
    k.CloseHandle(token);
  }
}
