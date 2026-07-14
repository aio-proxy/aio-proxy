import type { ZodType } from "zod";
import type { JsonValue } from "./json";

export type FormCondition = {
  readonly key: string;
  readonly equals: string | number | boolean | null;
};

type FormFieldBase<TType extends string> = {
  readonly type: TType;
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly when?: FormCondition;
};

export type FormField =
  | (FormFieldBase<"text"> & { readonly placeholder?: string })
  | (FormFieldBase<"secret"> & { readonly placeholder?: string })
  | (FormFieldBase<"number"> & { readonly placeholder?: string })
  | (FormFieldBase<"boolean"> & { readonly defaultValue?: boolean })
  | (FormFieldBase<"select"> & {
      readonly options: readonly {
        readonly value: string | number | boolean;
        readonly label: string;
        readonly description?: string;
      }[];
    })
  | (FormFieldBase<"json"> & {
      readonly placeholder?: string;
      readonly defaultValue?: JsonValue;
    });

export type ConfigSpec<T> = {
  readonly schema: ZodType<T>;
  readonly form: readonly FormField[];
};
