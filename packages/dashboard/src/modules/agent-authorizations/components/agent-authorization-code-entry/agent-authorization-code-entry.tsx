import { AioProxyLogo } from '@aio-proxy/brand';
import { m } from '@aio-proxy/i18n';
import type { AgentAuthorizationDetails } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Field, FieldError } from '@aio-proxy/ui/components/field';
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@aio-proxy/ui/components/input-otp';
import { useForm } from '@tanstack/react-form';
import { useEffect } from 'react';
import { z } from 'zod';

import { useAgentAuthorization } from '../../hooks/use-agent-authorization';
import { normalizeAgentUserCode } from '../../lib/user-code';
import { AgentAuthorizationRequestError } from '../../services/agent-authorizations-service';

const codeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
const otpSlots = [0, 1, 2, 3, 4, 5, 6, 7] as const;

const requestErrorMessage = (error: unknown): string =>
  typeof AgentAuthorizationRequestError === 'function' &&
  error instanceof AgentAuthorizationRequestError &&
  error.code === 'authorization_unavailable'
    ? m['dashboard.agent_authorization.password_required']()
    : m['dashboard.agent_authorization.network_error']();

interface AgentAuthorizationCodeEntryProps {
  readonly onResolved: (details: AgentAuthorizationDetails) => void;
}

export const AgentAuthorizationCodeEntry: React.FC<AgentAuthorizationCodeEntryProps> = ({ onResolved }) => {
  const { resolve } = useAgentAuthorization();
  const form = useForm({
    defaultValues: { userCode: '' },
    onSubmit: ({ value }) => {
      resolve.mutate(value.userCode, { onSuccess: onResolved });
    },
  });
  useEffect(() => {
    const code = new URLSearchParams(window.location.hash.slice(1)).get('code');
    if (code !== null) form.setFieldValue('userCode', normalizeAgentUserCode(code));
    if (window.location.hash !== '')
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }, [form]);

  return (
    <Card className="w-full max-w-sm" size="sm">
      <CardHeader className="text-center">
        <CardTitle>
          <h1 className="flex items-center justify-center gap-2 text-xl font-semibold">
            {m['dashboard.agent_authorization.title']()}
            <AioProxyLogo className="text-xl" />
          </h1>
        </CardTitle>
        <CardDescription>{m['dashboard.agent_authorization.instructions']()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col items-center gap-5"
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
                <div className="flex justify-center">
                  <InputOTP
                    id="agent-user-code"
                    aria-label={m['dashboard.agent_authorization.code_label']()}
                    containerClassName="gap-2"
                    maxLength={8}
                    autoComplete="one-time-code"
                    inputMode="text"
                    aria-invalid={field.state.meta.errors.length > 0 || undefined}
                    value={field.state.value.replaceAll('-', '')}
                    pasteTransformer={(pasted) => normalizeAgentUserCode(pasted).replaceAll('-', '')}
                    onBlur={field.handleBlur}
                    onChange={(value) => field.handleChange(normalizeAgentUserCode(value))}
                  >
                    <InputOTPGroup>
                      {otpSlots.slice(0, 4).map((index) => (
                        <InputOTPSlot key={index} index={index} />
                      ))}
                    </InputOTPGroup>
                    <InputOTPSeparator />
                    <InputOTPGroup>
                      {otpSlots.slice(4).map((index) => (
                        <InputOTPSlot key={index} index={index} />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                <FieldError errors={field.state.meta.errors.map((message) => ({ message: String(message) }))} />
              </Field>
            )}
          </form.Field>
          {resolve.error === null || resolve.error === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {requestErrorMessage(resolve.error)}
            </p>
          )}
          <Button type="submit" disabled={resolve.isPending}>
            {m['dashboard.agent_authorization.resolve']()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};
