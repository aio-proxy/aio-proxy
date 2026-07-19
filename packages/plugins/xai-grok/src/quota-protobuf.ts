const MIN_EPOCH_SECONDS = 1_700_000_000n;
const MAX_EPOCH_SECONDS = 2_100_000_000n;
const MAX_DEPTH = 4;

export type XAIGrokBillingSnapshot = {
  readonly usedPercent: number;
  readonly resetsAt?: number;
};

type Fixed32Field = { readonly path: readonly number[]; readonly value: number; readonly order: number };
type VarintField = { readonly path: readonly number[]; readonly value: bigint };
type ProtobufScan = {
  readonly fixed32: Fixed32Field[];
  readonly varints: VarintField[];
  order: number;
};
type GrpcWebFrames = { readonly data: readonly Uint8Array[]; readonly trailers: ReadonlyMap<string, string> };

export function validateXAIGrokGrpcStatus(headers: Headers): void {
  validateGrpcStatus(headers.get("grpc-status"));
}

export function parseXAIGrokBilling(data: Uint8Array, now = Date.now()): XAIGrokBillingSnapshot {
  const frames = parseGrpcWebFrames(data);
  let payloads: readonly Uint8Array[];
  if (frames === undefined) {
    if (!looksLikeProtobuf(data)) throw new Error("xAI Grok billing returned no protobuf payload");
    payloads = [data];
  } else {
    validateGrpcStatus(frames.trailers.get("grpc-status"));
    payloads = frames.data;
  }
  if (payloads.length === 0) throw new Error("xAI Grok billing returned no protobuf payload");

  const scan: ProtobufScan = { fixed32: [], varints: [], order: 0 };
  for (const payload of payloads) scanProtobuf(payload, 0, [], scan);
  const percent = selectUsedPercent(scan.fixed32);
  const resetsAt = selectReset(scan.varints, now);
  const noUsageYet =
    percent === undefined && scan.fixed32.length === 0 && resetsAt !== undefined && hasUsagePeriod(scan.varints);
  if (percent === undefined && !noUsageYet) throw new Error("Could not parse xAI Grok billing usage");
  return { usedPercent: percent ?? 0, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

function parseGrpcWebFrames(data: Uint8Array): GrpcWebFrames | undefined {
  const payloads: Uint8Array[] = [];
  const trailers = new Map<string, string>();
  let index = 0;
  while (index < data.length) {
    if (index + 5 > data.length) return undefined;
    const flags = data[index];
    if (flags === undefined) return undefined;
    const length = new DataView(data.buffer, data.byteOffset + index + 1, 4).getUint32(0);
    const start = index + 5;
    const end = start + length;
    if (end > data.length) return undefined;
    const payload = data.slice(start, end);
    if ((flags & 0x80) === 0) payloads.push(payload);
    else mergeTrailerFields(trailers, payload);
    index = end;
  }
  return { data: payloads, trailers };
}

function mergeTrailerFields(fields: Map<string, string>, payload: Uint8Array): void {
  const text = new TextDecoder().decode(payload);
  for (const line of text.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    fields.set(key, decodePercent(value));
  }
}

function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validateGrpcStatus(rawStatus: string | undefined | null): void {
  if (rawStatus === undefined || rawStatus === null || rawStatus === "0") return;
  throw new Error("xAI Grok billing RPC failed");
}

function looksLikeProtobuf(data: Uint8Array): boolean {
  const first = data[0];
  if (first === undefined) return false;
  const fieldNumber = first >> 3;
  const wireType = first & 0x07;
  return fieldNumber > 0 && (wireType === 0 || wireType === 1 || wireType === 2 || wireType === 5);
}

function scanProtobuf(data: Uint8Array, depth: number, path: readonly number[], scan: ProtobufScan): void {
  let index = 0;
  while (index < data.length) {
    const fieldStart = index;
    const key = readVarint(data, index);
    if (key === undefined || key.value === 0n) {
      index = fieldStart + 1;
      continue;
    }
    index = key.next;
    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 0x07n);
    const fieldPath = [...path, fieldNumber];
    if (wireType === 0) {
      const value = readVarint(data, index);
      if (value === undefined) index = fieldStart + 1;
      else {
        scan.varints.push({ path: fieldPath, value: value.value });
        index = value.next;
      }
      continue;
    }
    if (wireType === 1) {
      if (index + 8 > data.length) return;
      index += 8;
      continue;
    }
    if (wireType === 2) {
      const length = readVarint(data, index);
      if (length === undefined || length.value > BigInt(data.length - length.next)) {
        index = fieldStart + 1;
        continue;
      }
      const end = length.next + Number(length.value);
      if (depth < MAX_DEPTH) scanProtobuf(data.slice(length.next, end), depth + 1, fieldPath, scan);
      index = end;
      continue;
    }
    if (wireType === 5) {
      if (index + 4 > data.length) return;
      const value = new DataView(data.buffer, data.byteOffset + index, 4).getFloat32(0, true);
      scan.fixed32.push({ path: fieldPath, value, order: scan.order++ });
      index += 4;
      continue;
    }
    index = fieldStart + 1;
  }
}

function readVarint(data: Uint8Array, start: number): { readonly value: bigint; readonly next: number } | undefined {
  let value = 0n;
  let shift = 0n;
  let index = start;
  while (index < data.length && shift < 64n) {
    const byte = data[index];
    if (byte === undefined) return undefined;
    index++;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: index };
    shift += 7n;
  }
  return undefined;
}

function selectUsedPercent(fields: readonly Fixed32Field[]): number | undefined {
  return fields
    .filter(({ path, value }) => path.at(-1) === 1 && Number.isFinite(value) && value >= 0 && value <= 100)
    .sort((left, right) => left.path.length - right.path.length || left.order - right.order)[0]?.value;
}

function selectReset(fields: readonly VarintField[], now: number): number | undefined {
  const future = fields
    .filter(({ value }) => value >= MIN_EPOCH_SECONDS && value <= MAX_EPOCH_SECONDS && Number(value) * 1_000 > now)
    .map(({ path, value }) => ({ path, milliseconds: Number(value) * 1_000 }));
  return (future.filter(({ path }) => equalPath(path, [1, 5, 1])).sort(byTimestamp)[0] ?? future.sort(byTimestamp)[0])
    ?.milliseconds;
}

function byTimestamp(left: { readonly milliseconds: number }, right: { readonly milliseconds: number }): number {
  return left.milliseconds - right.milliseconds;
}

function hasUsagePeriod(fields: readonly VarintField[]): boolean {
  return fields.some(
    ({ path, value }) => startsWithPath(path, [1, 6]) || (equalPath(path, [1, 8, 1]) && (value === 1n || value === 2n)),
  );
}

function startsWithPath(path: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((value, index) => path[index] === value);
}

function equalPath(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && startsWithPath(left, right);
}
