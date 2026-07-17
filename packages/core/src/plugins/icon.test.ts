import { describe, expect, test } from "bun:test";
import { MAX_OAUTH_ICON_BYTES, validateOAuthIcon } from "./icon";

describe("validateOAuthIcon", () => {
  test.each([
    "openai",
    "codex-color",
    "http://example.com/icon.svg",
    "https://cdn.example.com/icon.webp",
    "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E",
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/webp;base64,UklGRg==",
    "data:image/gif;base64,R0lGODlh",
    "data:image/avif;base64,AAAA",
  ])("accepts %s", (icon) => {
    expect(validateOAuthIcon(icon)).toEqual({ ok: true, value: icon });
  });

  test.each([
    1,
    "OpenAI",
    "open_ai",
    "ftp://example.com/icon.svg",
    "http:///missing-host.svg",
    "data:text/html,%3Cb%3Ex%3C%2Fb%3E",
    "data:image/jpeg;base64,/9j/",
    `data:image/png,${"a".repeat(MAX_OAUTH_ICON_BYTES)}`,
  ])("rejects an invalid icon without returning it", (icon) => {
    const result = validateOAuthIcon(icon);
    expect(result).toEqual({ ok: false });
    expect(result).not.toHaveProperty("value");
  });
});
