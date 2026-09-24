import type { ZodType } from 'zod';

import type { JsonValue } from './json';
import type { LocalizedText } from './localized-text';

export type FormCondition =
  | { readonly key: string; readonly equals: string | number | boolean | null }
  | { readonly key: string; readonly notEquals: string | number | boolean | null };

type FormFieldBase<TType extends string> = {
  readonly type: TType;
  readonly key: string;
  readonly label: LocalizedText;
  readonly description?: LocalizedText;
  readonly when?: FormCondition;
};

export type ProviderField = FormFieldBase<'provider'> & {
  readonly protocols?: readonly string[];
};
export type ProviderModelField = FormFieldBase<'provider-model'> & { readonly providerKey: string };

export type FormField =
  | (FormFieldBase<'text'> & { readonly placeholder?: LocalizedText; readonly defaultValue?: string })
  | FormFieldBase<'secret'>
  | (FormFieldBase<'number'> & { readonly placeholder?: LocalizedText })
  | (FormFieldBase<'boolean'> & { readonly defaultValue?: boolean })
  | (FormFieldBase<'select'> & {
      readonly defaultValue?: string | number | boolean;
      readonly options: readonly {
        readonly value: string | number | boolean;
        readonly label: LocalizedText;
        readonly description?: LocalizedText;
      }[];
    })
  | (FormFieldBase<'json'> & {
      readonly placeholder?: LocalizedText;
      readonly defaultValue?: JsonValue;
    })
  | ProviderField
  | ProviderModelField;

export type ConfigSpec<T> = {
  readonly schema: ZodType<T>;
  readonly form: readonly FormField[];
};
