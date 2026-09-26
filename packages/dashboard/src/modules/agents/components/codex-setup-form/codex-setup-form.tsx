import { m } from '@aio-proxy/i18n';
import type { CodexConfigureInput, CodexSetupPlan } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';
import { Field, FieldDescription, FieldError, FieldLabel, FieldSet, FieldLegend } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';

import { useCodexSetupForm } from '../../hooks/use-codex-setup-form';

interface CodexSetupFormProps {
  readonly plan: CodexSetupPlan;
  readonly busy: boolean;
  readonly onSubmit: (input: CodexConfigureInput) => void;
  readonly onRestoreMigration: (operationId: string) => void;
}

const NO_KEY = '';

export const CodexSetupForm: React.FC<CodexSetupFormProps> = ({ plan, busy, onSubmit, onRestoreMigration }) => {
  const form = useCodexSetupForm(plan, onSubmit);
  const conflict = plan.inspection.status === 'conflict';
  const authItems = [
    { value: 'keep-chatgpt', label: m['dashboard.agents.codex.auth_keep']() },
    { value: 'command', label: m['dashboard.agents.codex.auth_command']() },
  ];
  const keyItems = [
    ...plan.keyChoices.map((choice) => ({ value: choice.id, label: choice.label })),
    { value: NO_KEY, label: m['dashboard.agents.codex.key_none']() },
  ];
  return (
    <form
      className="space-y-4"
      data-testid="codex-setup-form"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      {conflict ? (
        <p role="alert" className="text-sm text-destructive">
          {m['dashboard.agents.codex.conflict']()}
        </p>
      ) : null}
      <form.Field
        name="providerId"
        validators={{
          onSubmit: ({ value }) => {
            const id = value.trim();
            if (id.length === 0) return m['dashboard.agents.error.invalid_provider_id']();
            return plan.occupiedProviderIds.includes(id)
              ? m['dashboard.agents.error.occupied_provider_id']()
              : undefined;
          },
        }}
      >
        {(field) => (
          <Field data-invalid={field.state.meta.errors.length > 0 || undefined}>
            <FieldLabel htmlFor="codex-provider-id">{m['dashboard.agents.codex.provider_id']()}</FieldLabel>
            <Input
              id="codex-provider-id"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <FieldDescription>{m['dashboard.agents.codex.provider_id_help']()}</FieldDescription>
            <FieldError errors={field.state.meta.errors.map((message) => ({ message: String(message) }))} />
          </Field>
        )}
      </form.Field>
      <form.Field name="authMode">
        {(field) => (
          <Field>
            <FieldLabel>{m['dashboard.agents.codex.auth_mode']()}</FieldLabel>
            <Select
              items={authItems}
              value={field.state.value}
              onValueChange={(value) => field.handleChange(value === 'command' ? 'command' : 'keep-chatgpt')}
            >
              <SelectTrigger className="w-full" aria-label={m['dashboard.agents.codex.auth_mode']()}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {authItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {field.state.value === 'command'
                ? m['dashboard.agents.codex.auth_command_help']()
                : m['dashboard.agents.codex.auth_keep_help']()}
            </FieldDescription>
          </Field>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.authMode}>
        {(authMode) =>
          authMode !== 'keep-chatgpt' || plan.keyChoices.length === 0 ? null : (
            <form.Field name="keyId">
              {(field) => (
                <Field data-testid="codex-key-field">
                  <FieldLabel>{m['dashboard.agents.codex.key']()}</FieldLabel>
                  <Select
                    items={keyItems}
                    value={field.state.value}
                    onValueChange={(value) => field.handleChange(value ?? NO_KEY)}
                  >
                    <SelectTrigger className="w-full" aria-label={m['dashboard.agents.codex.key']()}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {keyItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </form.Field>
          )
        }
      </form.Subscribe>
      <form.Subscribe selector={(state) => state.values.providerId.trim()}>
        {(providerId) => {
          const groups = plan.sessions.groups.filter((group) => group.providerId !== providerId);
          if (groups.length === 0) return null;
          return (
            <FieldSet data-testid="codex-migration">
              <FieldLegend>{m['dashboard.agents.codex.migrate']()}</FieldLegend>
              <FieldDescription>{m['dashboard.agents.codex.migrate_help']()}</FieldDescription>
              <form.Field name="migrateFrom">
                {(field) => (
                  <div className="space-y-2">
                    {groups.map((group) => (
                      <FieldLabel key={group.providerId}>
                        <Checkbox
                          checked={field.state.value.includes(group.providerId)}
                          onCheckedChange={(checked) =>
                            field.handleChange(
                              checked
                                ? [...field.state.value, group.providerId]
                                : field.state.value.filter((id) => id !== group.providerId),
                            )
                          }
                        />
                        {m['dashboard.agents.codex.migrate_group']({
                          providerId: group.providerId,
                          active: String(group.active),
                          archived: String(group.archived),
                        })}
                      </FieldLabel>
                    ))}
                  </div>
                )}
              </form.Field>
              <form.Field
                name="confirmMigration"
                validators={{
                  onChangeListenTo: ['migrateFrom'],
                  onSubmit: ({ value, fieldApi }) =>
                    fieldApi.form.getFieldValue('migrateFrom').length > 0 && !value
                      ? m['dashboard.agents.codex.migrate_confirm']()
                      : undefined,
                }}
              >
                {(field) => (
                  <Field data-invalid={field.state.meta.errors.length > 0 || undefined}>
                    <FieldLabel>
                      <Checkbox
                        checked={field.state.value}
                        onCheckedChange={(checked) => field.handleChange(checked === true)}
                      />
                      {m['dashboard.agents.codex.migrate_confirm']()}
                    </FieldLabel>
                  </Field>
                )}
              </form.Field>
            </FieldSet>
          );
        }}
      </form.Subscribe>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || conflict}>
          {m['dashboard.agents.codex.submit']()}
        </Button>
        {plan.lastMigrationOperationId === undefined ? null : (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onRestoreMigration(plan.lastMigrationOperationId!)}
          >
            {m['dashboard.agents.action.restore_migration']()}
          </Button>
        )}
      </div>
    </form>
  );
};
