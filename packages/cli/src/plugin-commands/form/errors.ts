import { m } from "@aio-proxy/i18n";

export class FormNumberInvalidError extends Error {
  override readonly name = "FormNumberInvalidError";
  constructor(readonly key: string) {
    super(m.cli_plugin_error_number_invalid({ key }));
  }
}

export class FormJsonInvalidError extends Error {
  override readonly name = "FormJsonInvalidError";
  constructor(readonly key: string) {
    super(m.cli_plugin_error_json_invalid({ key }));
  }
}

export type FormSchemaIssue = { readonly key: string; readonly message: string };

export class FormSchemaValidationError extends Error {
  override readonly name = "FormSchemaValidationError";
  constructor(readonly issues: readonly FormSchemaIssue[]) {
    super(m.cli_plugin_error_options_invalid());
  }
}
