import { m } from '@aio-proxy/i18n';
import type { ClaudeCodeConfigureInput, ClaudeCodeSetupPlan } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';

import { useClaudeCodeSetupForm } from '../../hooks/use-claude-code-setup-form';

interface ClaudeCodeSetupFormProps {
  /** Shown only while the proxy has API keys: one of them must be picked, never assumed. */
  readonly plan: ClaudeCodeSetupPlan;
  readonly busy: boolean;
  readonly onSubmit: (input: ClaudeCodeConfigureInput) => void;
}

export const ClaudeCodeSetupForm: React.FC<ClaudeCodeSetupFormProps> = ({ plan, busy, onSubmit }) => {
  const form = useClaudeCodeSetupForm(plan, onSubmit);
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
      <form.Field name="keyId">
        {(field) => (
          <Field>
            <FieldLabel>{m['dashboard.agents.codex.key']()}</FieldLabel>
            <Select items={items} value={field.state.value} onValueChange={(value) => field.handleChange(value ?? '')}>
              <SelectTrigger className="w-full" aria-label={m['dashboard.agents.codex.key']()}>
                <SelectValue />
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
          </Field>
        )}
      </form.Field>
      <Button type="submit" disabled={busy}>
        {m['dashboard.agents.codex.submit']()}
      </Button>
    </form>
  );
};
