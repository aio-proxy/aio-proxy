import { isPlainObject } from 'es-toolkit/predicate';
import { decodeJwt } from 'jose';

type JwtPayload = ReturnType<typeof decodeJwt>;

export function extractAccountId(token: string): string | undefined {
  let payload: JwtPayload;
  try {
    payload = decodeJwt(token);
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }

  const topLevel = Reflect.get(payload, 'chatgpt_account_id');
  if (typeof topLevel === 'string') return topLevel;

  const auth = payload['https://api.openai.com/auth'];
  if (isPlainObject(auth)) {
    const nested = Reflect.get(Object(auth), 'chatgpt_account_id');
    if (typeof nested === 'string') return nested;
  }

  const organizations = Reflect.get(payload, 'organizations');
  if (!Array.isArray(organizations) || organizations.length === 0) return undefined;

  const firstOrganization = organizations[0];
  if (isPlainObject(firstOrganization)) {
    const id = Reflect.get(Object(firstOrganization), 'id');
    if (typeof id === 'string') return id;
  }

  return undefined;
}

export function normalizeChatGPTEmail(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email === '' ? undefined : email;
}

export function extractEmail(token: string): string | undefined {
  let payload: JwtPayload;
  try {
    payload = decodeJwt(token);
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }

  const email = Reflect.get(payload, 'email');
  return normalizeChatGPTEmail(typeof email === 'string' ? email : undefined);
}
