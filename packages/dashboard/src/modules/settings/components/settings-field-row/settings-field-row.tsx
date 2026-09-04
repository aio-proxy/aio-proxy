import { Field, FieldContent, FieldDescription, FieldError } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';

interface SettingsFieldRowProps {
  readonly label: string;
  readonly htmlFor?: string;
  readonly description?: React.ReactNode;
  readonly error?: React.ReactNode;
  readonly children: React.ReactNode;
}

// One setting per row: label and helper text on the left, the control on the right.
// `horizontal` rather than `responsive` on purpose — the responsive variant sizes children
// with `*:w-full`/`*:w-auto`, which a control cannot override, so the control column would
// collapse to its content width. Stacking below the container breakpoint is done here instead.
export const SettingsFieldRow: React.FC<SettingsFieldRowProps> = ({ label, htmlFor, description, error, children }) => (
  <Field orientation="horizontal" className="@max-md/field-group:flex-col @max-md/field-group:items-start">
    <FieldContent>
      <Label htmlFor={htmlFor}>{label}</Label>
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldError>{error}</FieldError>
    </FieldContent>
    <div className="w-full @md/field-group:w-64 @md/field-group:shrink-0">{children}</div>
  </Field>
);
