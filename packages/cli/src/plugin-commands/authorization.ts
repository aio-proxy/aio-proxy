import { getLocale, m } from "@aio-proxy/i18n";
import { type AuthorizationPort, LocalizedTextSchema, resolveLocalizedText } from "@aio-proxy/plugin-sdk";
import { AuthorizationUrlInvalidError, runLoopbackAuthorization } from "./loopback";

export type CliAuthorizationDeps = {
  readonly copy: {
    readonly copiedDeviceCode: string;
    readonly deviceCode: (code: string) => string;
    readonly openedAuthorizationPage: string;
    readonly successHtml: string;
    readonly alreadyCompleted: string;
    readonly invalidCallback: string;
    readonly notFound: string;
  };
  readonly openBrowser: (url: string) => boolean;
  readonly copyToClipboard: (value: string) => boolean;
  readonly print: (message: string) => void;
  readonly readManualCallbackUrl: (authorizationUrl: string, signal: AbortSignal) => Promise<string>;
  readonly confirmManualOnly: (redirectUri: string) => Promise<boolean>;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  readonly locale?: string;
};

export function createDefaultCliAuthorizationCopy(): CliAuthorizationDeps["copy"] {
  return {
    copiedDeviceCode: m.cli_oauth_copied_device_code(),
    deviceCode: (code) => m.cli_oauth_device_code({ code }),
    openedAuthorizationPage: m.cli_oauth_opened_authorization_page(),
    successHtml: m.cli_oauth_success_html(),
    alreadyCompleted: m.cli_oauth_callback_already_completed(),
    invalidCallback: m.cli_oauth_invalid_callback_response(),
    notFound: m.cli_oauth_callback_not_found(),
  };
}

function requireHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthorizationUrlInvalidError();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AuthorizationUrlInvalidError();
  }
  return url;
}

export function createCliAuthorizationPort(deps: CliAuthorizationDeps): AuthorizationPort {
  return {
    async presentDeviceCode(input) {
      const url = requireHttpUrl(input.url);
      let copied = false;
      try {
        copied = deps.copyToClipboard(input.userCode);
      } catch {
        copied = false;
      }
      if (copied) {
        deps.print(deps.copy.copiedDeviceCode);
      } else {
        deps.print(deps.copy.deviceCode(input.userCode));
      }
      let opened = false;
      try {
        opened = deps.openBrowser(url.href);
      } catch {
        opened = false;
      }
      if (opened) {
        deps.print(deps.copy.openedAuthorizationPage);
      }
      deps.print(url.href);
      if (input.instructions !== undefined) {
        const instructions = LocalizedTextSchema.safeParse(input.instructions);
        if (instructions.success) {
          deps.print(resolveLocalizedText(instructions.data, deps.locale ?? getLocale()));
        }
      }
    },
    loopback: (input) => runLoopbackAuthorization(input, deps),
  };
}
