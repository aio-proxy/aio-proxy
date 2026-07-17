import type { OAuthIcon } from "@aio-proxy/plugin-sdk";

export const MAX_OAUTH_ICON_BYTES = 256 * 1024;
const LOBE_ICON_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DATA_MIME = new Set(["image/svg+xml", "image/png", "image/webp", "image/gif", "image/avif"]);
const MIME_PARAMETER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[^"\\]|\\.)*")$/u;

export type OAuthIconValidationResult = { readonly ok: true; readonly value: OAuthIcon } | { readonly ok: false };

function validDataUrl(value: string): boolean {
  const comma = value.indexOf(",");
  if (comma < 0) return false;
  const [rawMime = "", ...parameters] = value.slice(5, comma).split(";");
  if (!DATA_MIME.has(rawMime.toLowerCase())) return false;
  let sawBase64 = false;
  for (const [index, parameter] of parameters.entries()) {
    if (parameter.toLowerCase() === "base64") {
      if (sawBase64 || index !== parameters.length - 1) return false;
      sawBase64 = true;
    } else if (!MIME_PARAMETER.test(parameter)) {
      return false;
    }
  }
  try {
    new URL(value);
    const payload = decodeURIComponent(value.slice(comma + 1));
    if (sawBase64) atob(payload);
    return true;
  } catch {
    return false;
  }
}

export function validateOAuthIcon(value: unknown): OAuthIconValidationResult {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_OAUTH_ICON_BYTES) {
    return { ok: false };
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    if (value.startsWith("http:///") || value.startsWith("https:///")) return { ok: false };
    try {
      const url = new URL(value);
      return url.hostname !== "" && (url.protocol === "http:" || url.protocol === "https:")
        ? { ok: true, value: value as OAuthIcon }
        : { ok: false };
    } catch {
      return { ok: false };
    }
  }
  if (value.startsWith("data:")) return validDataUrl(value) ? { ok: true, value: value as OAuthIcon } : { ok: false };
  return LOBE_ICON_SLUG.test(value) ? { ok: true, value: value as OAuthIcon } : { ok: false };
}
