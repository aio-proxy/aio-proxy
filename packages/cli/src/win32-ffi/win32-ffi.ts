import { dlopen, FFIType, type Pointer } from 'bun:ffi';

// Every function loads kernel32 on first use, so importing this module on macOS/Linux never calls dlopen.
const loadKernel32 = () =>
  dlopen('kernel32.dll', {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    QueryFullProcessImageNameW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
let kernel32Symbols: ReturnType<typeof loadKernel32> | undefined;
const kernel32 = () => (kernel32Symbols ??= loadKernel32());

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
