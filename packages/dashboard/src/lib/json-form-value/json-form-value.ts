/**
 * Encoding helpers shared by the two schema-driven `DashboardOAuthFormField` renderers
 * (`modules/providers/components/oauth-account-field.tsx` and
 * `modules/plugins/components/plugin-options-field.tsx`) and by the OAuth account form's validator.
 * They live here rather than in either module because both modules render the same field type, and a
 * copy per module is how those two renderers drifted apart in the first place.
 */

/**
 * A `<Select>` value is a string, so a schema option's number or boolean value has to round-trip
 * through JSON to survive selection.
 */
export const optionValue = (value: string | number | boolean) => JSON.stringify(value);

/** Empty is not invalid: it is how a JSON field says "no value" before anything is typed. */
export const isValidJson = (value: string) => {
  if (value === '') return true;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};
