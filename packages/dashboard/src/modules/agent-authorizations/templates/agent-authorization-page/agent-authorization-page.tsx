import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Field, FieldError, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { useForm } from '@tanstack/react-form';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { useAgentAuthorization } from '../../hooks/use-agent-authorization';
import { normalizeAgentUserCode } from '../../lib/user-code';
import { AgentAuthorizationRequestError } from '../../services/agent-authorizations-service';

const codeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
const terminalMessage = (status: 'approved' | 'denied' | 'expired' | 'consumed'): string => {
  if (status === 'approved') return m['dashboard.agent_authorization.approved']();
  if (status === 'denied') return m['dashboard.agent_authorization.denied']();
  if (status === 'expired') return m['dashboard.agent_authorization.expired']();
  return m['dashboard.agent_authorization.consumed']();
};

export const AgentAuthorizationPage: React.FC = () => {
  const authorization = useAgentAuthorization();
  const [dismissed, setDismissed] = useState(false);
  const form = useForm({
    defaultValues: { userCode: '' },
    onSubmit: ({ value }) => {
      setDismissed(false);
      authorization.approve.reset();
      authorization.deny.reset();
      authorization.resolve.mutate(value.userCode);
    },
  });
  useEffect(() => {
    const code = new URLSearchParams(window.location.hash.slice(1)).get('code');
    if (code !== null) form.setFieldValue('userCode', normalizeAgentUserCode(code));
    if (window.location.hash !== '')
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }, [form]);

  const result = dismissed
    ? undefined
    : (authorization.approve.data ?? authorization.deny.data ?? authorization.resolve.data);
  const pending = result?.status === 'pending' ? result : undefined;
  const isPending = authorization.resolve.isPending || authorization.approve.isPending || authorization.deny.isPending;
  const error = authorization.resolve.error ?? authorization.approve.error ?? authorization.deny.error;
  const errorMessage =
    typeof AgentAuthorizationRequestError === 'function' &&
    error instanceof AgentAuthorizationRequestError &&
    error.code === 'authorization_unavailable'
      ? m['dashboard.agent_authorization.password_required']()
      : m['dashboard.agent_authorization.network_error']();

  return (
    <main className="mx-auto flex min-h-full max-w-2xl items-center px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>
            <h1>{m['dashboard.agent_authorization.title']()}</h1>
          </CardTitle>
          <CardDescription>{m['dashboard.agent_authorization.instructions']()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {result === undefined ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
              }}
            >
              <form.Field
                name="userCode"
                validators={{
                  onSubmit: ({ value }) =>
                    codeSchema.safeParse(value).success ? undefined : m['dashboard.agent_authorization.code_invalid'](),
                }}
              >
                {(field) => (
                  <Field data-invalid={field.state.meta.errors.length > 0 || undefined}>
                    <FieldLabel htmlFor="agent-user-code">{m['dashboard.agent_authorization.code_label']()}</FieldLabel>
                    <Input
                      id="agent-user-code"
                      autoComplete="one-time-code"
                      value={field.state.value}
                      placeholder={m['dashboard.agent_authorization.code_placeholder']()}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(normalizeAgentUserCode(event.target.value))}
                    />
                    <FieldError errors={field.state.meta.errors.map((message) => ({ message: String(message) }))} />
                  </Field>
                )}
              </form.Field>
              <Button type="submit" disabled={isPending}>
                {m['dashboard.agent_authorization.resolve']()}
              </Button>
            </form>
          ) : null}

          {pending === undefined ? null : (
            <section aria-label={m['dashboard.agent_authorization.permissions_title']()}>
              <h2>{m['dashboard.agent_authorization.permissions_title']()}</h2>
              <p>{m['dashboard.agent_authorization.pending']()}</p>
              <dl>
                <dt>{m['dashboard.agent_authorization.target']()}</dt>
                <dd>{pending.target}</dd>
                <dt>{m['dashboard.agent_authorization.installation']()}</dt>
                <dd>{pending.installationId}</dd>
                <dt>{m['dashboard.agent_authorization.version']()}</dt>
                <dd>{pending.adapterVersion}</dd>
                <dt>{m['dashboard.agent_authorization.expires']()}</dt>
                <dd>{new Date(pending.expiresAt).toLocaleString()}</dd>
              </dl>
              <ul>
                <li>{m['dashboard.agent_authorization.permission_catalog']()}</li>
                <li>{m['dashboard.agent_authorization.permission_inference']()}</li>
              </ul>
              <div className="flex gap-3">
                <Button disabled={isPending} onClick={() => authorization.approve.mutate(pending.deviceId)}>
                  {m['dashboard.agent_authorization.approve']()}
                </Button>
                <Button
                  variant="outline"
                  disabled={isPending}
                  onClick={() => authorization.deny.mutate(pending.deviceId)}
                >
                  {m['dashboard.agent_authorization.deny']()}
                </Button>
              </div>
            </section>
          )}

          {result !== undefined && result.status !== 'pending' ? (
            <section role="status">
              <p>{terminalMessage(result.status)}</p>
              <Button
                variant="outline"
                onClick={() => {
                  setDismissed(true);
                  authorization.reset();
                }}
              >
                {m['dashboard.agent_authorization.retry']()}
              </Button>
            </section>
          ) : null}
          {error === null || error === undefined ? null : <p role="alert">{errorMessage}</p>}
        </CardContent>
      </Card>
    </main>
  );
};
