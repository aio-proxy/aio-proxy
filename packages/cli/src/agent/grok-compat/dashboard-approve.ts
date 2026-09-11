import { isPlainObject } from 'es-toolkit/predicate';

import { parseDeviceVerificationUrl } from './helper-capture';

export type DashboardApproveResult = {
  readonly userCode: string;
  readonly deviceId: string;
};

function dashboardHeaders(origin: string, token?: string): HeadersInit {
  return {
    'content-type': 'application/json',
    origin,
    'sec-fetch-site': 'same-origin',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function approveDashboardAuthorization(options: {
  readonly endpoint: string;
  readonly password: string;
  readonly verificationUrl: string;
}): Promise<DashboardApproveResult> {
  const origin = new URL(options.endpoint).origin;
  const parsed = parseDeviceVerificationUrl(options.verificationUrl);
  if (parsed === undefined) throw new Error('device verification URL missing from helper stderr');
  const login = await fetch(`${origin}/dashboard/api/auth/login`, {
    method: 'POST',
    headers: dashboardHeaders(origin),
    body: JSON.stringify({ password: options.password }),
  });
  const loginBody = await readJson(login);
  if (!login.ok || !isPlainObject(loginBody) || typeof loginBody['token'] !== 'string') {
    throw new Error(`Dashboard login failed (${String(login.status)})`);
  }
  const token = loginBody['token'];
  const resolved = await fetch(`${origin}/dashboard/api/agent-authorizations/resolve`, {
    method: 'POST',
    headers: dashboardHeaders(origin, token),
    body: JSON.stringify({ userCode: parsed.userCode }),
  });
  const resolvedBody = await readJson(resolved);
  if (!resolved.ok || !isPlainObject(resolvedBody) || typeof resolvedBody['deviceId'] !== 'string') {
    throw new Error(`Dashboard resolve failed (${String(resolved.status)})`);
  }
  const deviceId = resolvedBody['deviceId'];
  const approved = await fetch(`${origin}/dashboard/api/agent-authorizations/${deviceId}/approve`, {
    method: 'POST',
    headers: dashboardHeaders(origin, token),
    body: '{}',
  });
  const approvedBody = await readJson(approved);
  if (!approved.ok || !isPlainObject(approvedBody) || approvedBody['status'] !== 'approved') {
    throw new Error(`Dashboard approve failed (${String(approved.status)})`);
  }
  return { userCode: parsed.userCode, deviceId };
}
