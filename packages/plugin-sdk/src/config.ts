import type { ZodType } from "zod";
import type { JsonValue } from "./json";
import type { LocalizedText } from "./localized-text";

export type FormCondition = {
  readonly key: string;
  readonly equals: string | number | boolean | null;
};

type FormFieldBase<TType extends string> = {
  readonly type: TType;
  readonly key: string;
  readonly label: LocalizedText;
  readonly description?: LocalizedText;
  readonly when?: FormCondition;
};

export type FormField =
  | (FormFieldBase<"text"> & { readonly placeholder?: LocalizedText })
  | FormFieldBase<"secret">
  | (FormFieldBase<"number"> & { readonly placeholder?: LocalizedText })
  | (FormFieldBase<"boolean"> & { readonly defaultValue?: boolean })
  | (FormFieldBase<"select"> & {
      readonly options: readonly {
        readonly value: string | number | boolean;
        readonly label: LocalizedText;
        readonly description?: LocalizedText;
      }[];
    })
  | (FormFieldBase<"json"> & {
      readonly placeholder?: LocalizedText;
      readonly defaultValue?: JsonValue;
    });

export type ConfigSpec<T> = {
  readonly schema: ZodType<T>;
  readonly form: readonly FormField[];
};
