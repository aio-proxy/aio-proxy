import { isRecord } from '@aio-proxy/shared';

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

export function httpStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const code = error['code'];
  if (isHttpStatus(code)) return code;
  const data = error['data'];
  if (!isRecord(data)) return undefined;
  const nested = data['code'];
  return isHttpStatus(nested) ? nested : undefined;
}
