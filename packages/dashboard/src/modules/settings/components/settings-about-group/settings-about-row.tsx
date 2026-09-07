import { Field, FieldContent, FieldDescription } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';

interface SettingsAboutRowProps {
  readonly label: string;
  readonly description: React.ReactNode;
  readonly href?: string;
  readonly children?: React.ReactNode;
}

const rowClassName = '@max-md/field-group:flex-col @max-md/field-group:items-start';

export const SettingsAboutRow: React.FC<SettingsAboutRowProps> = ({ label, description, href, children }) => {
  const body = (
    <Field orientation="horizontal" className={rowClassName} {...(href === undefined ? {} : { role: 'presentation' })}>
      <FieldContent>
        <Label>{label}</Label>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      {children === undefined ? null : <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>}
    </Field>
  );

  if (href === undefined) return body;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      {body}
    </a>
  );
};
