import { normalizeEffort } from '../reasoning-effort/index';
import { readRequestText } from '../request';

export async function rewriteOpenAICompletionsRaw(
  raw: Request,
  resolvedModel: string,
  supportedEfforts: ReadonlySet<string>,
): Promise<Request> {
  // Read the decoded body once so a no-op rewrite can forward it verbatim
  // rather than round-tripping through JSON, which would silently truncate
  // large integers and drop the client's exact byte representation.
  const bodyText = await readRequestText(raw);
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  const effort = body['reasoning_effort'];
  const nextEffort = typeof effort === 'string' ? normalizeEffort(effort, supportedEfforts) : effort;
  const headers = new Headers(raw.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  // Chat Completions carries the model in the body, so any change to model or
  // effort forces a re-serialization; otherwise forward the untouched bytes.
  const modelUnchanged = body['model'] === resolvedModel;
  const effortUnchanged = nextEffort === effort;
  const forwardedBody =
    modelUnchanged && effortUnchanged
      ? bodyText
      : JSON.stringify({
          ...body,
          model: resolvedModel,
          ...(nextEffort === undefined ? {} : { reasoning_effort: nextEffort }),
        });
  return new Request(raw, {
    method: raw.method,
    body: forwardedBody,
    headers,
  });
}
