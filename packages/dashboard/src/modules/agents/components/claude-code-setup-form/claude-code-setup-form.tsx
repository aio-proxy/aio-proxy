import { m } from '@aio-proxy/i18n';
import { ClaudeCodeKeyIdSchema, type ClaudeCodeConfigureInput, type ClaudeCodeSetupPlan } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@aio-proxy/ui/components/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';

import { useClaudeCodeSetupForm } from '../../hooks/use-claude-code-setup-form';

interface ClaudeCodeSetupFormProps {
  /** Shown only while the proxy has API keys: one of them must be picked, never assumed. */
  readonly plan: ClaudeCodeSetupPlan;
  readonly busy: boolean;
  readonly onSubmit: (input: ClaudeCodeConfigureInput) => void;
}

export const ClaudeCodeSetupForm: React.FC<ClaudeCodeSetupFormProps> = ({ plan, busy, onSubmit }) => {
  const form = useClaudeCodeSetupForm(onSubmit);
  const items = plan.keyChoices.map((choice) => ({ value: choice.id, label: choice.label }));
  return (
    <form
      className="space-y-4"
      data-testid="claude-code-setup-form"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field
        name="keyId"
        validators={{
          // The API's own schema, so an empty choice is refused here exactly as the server would refuse it.
          onSubmit: ({ value }) =>
            ClaudeCodeKeyIdSchema.safeParse(value).success
              ? undefined
              : m['dashboard.agents.claude_code.key_required'](),
        }}
      >
        {(field) => (
          <Field data-invalid={field.state.meta.errors.length > 0 || undefined}>
            <FieldLabel>{m['dashboard.agents.codex.key']()}</FieldLabel>
            <Select items={items} value={field.state.value} onValueChange={(value) => field.handleChange(value ?? '')}>
              <SelectTrigger className="w-full" aria-label={m['dashboard.agents.codex.key']()}>
                <SelectValue placeholder={m['dashboard.agents.claude_code.key_placeholder']()} />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{m['dashboard.agents.claude_code.key_help']()}</FieldDescription>
            <FieldError errors={field.state.meta.errors.map((message) => ({ message: String(message) }))} />
          </Field>
        )}
      </form.Field>
      <Button type="submit" disabled={busy}>
        {m['dashboard.agents.codex.submit']()}
      </Button>
    </form>
  );
};
