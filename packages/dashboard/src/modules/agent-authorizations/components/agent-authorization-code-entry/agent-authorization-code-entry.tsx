import { m } from '@aio-proxy/i18n';
import type { AgentAuthorizationDetails } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { CardContent, CardFooter } from '@aio-proxy/ui/components/card';
import { Field, FieldError } from '@aio-proxy/ui/components/field';
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@aio-proxy/ui/components/input-otp';
import { toast } from '@aio-proxy/ui/components/toast';
import { useForm } from '@tanstack/react-form';
import { useEffect } from 'react';
import { z } from 'zod';

import { useAgentAuthorization } from '../../hooks/use-agent-authorization';
import { normalizeAgentUserCode } from '../../lib/user-code';
import { AgentAuthorizationRequestError } from '../../services/agent-authorizations-service';
import { AgentAuthorizationCard } from '../card';

const codeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
const otpSlots = [0, 1, 2, 3, 4, 5, 6, 7] as const;

type PendingAuthorization = Extract<AgentAuthorizationDetails, { status: 'pending' }>;

const terminalMessage = (status: Exclude<AgentAuthorizationDetails['status'], 'pending'>): string => {
  if (status === 'approved') return m['dashboard.agent_authorization.approved']();
  if (status === 'denied') return m['dashboard.agent_authorization.denied']();
  if (status === 'expired') return m['dashboard.agent_authorization.expired']();
  return m['dashboard.agent_authorization.consumed']();
};

const requestErrorMessage = (error: unknown): string =>
  typeof AgentAuthorizationRequestError === 'function' &&
  error instanceof AgentAuthorizationRequestError &&
  error.code === 'authorization_unavailable'
    ? m['dashboard.agent_authorization.password_required']()
    : m['dashboard.agent_authorization.network_error']();

interface AgentAuthorizationCodeEntryProps {
  readonly onResolved: (details: PendingAuthorization) => void;
}

export const AgentAuthorizationCodeEntry: React.FC<AgentAuthorizationCodeEntryProps> = ({ onResolved }) => {
  const { resolve } = useAgentAuthorization();
  const form = useForm({
    defaultValues: { userCode: '' },
    onSubmit: ({ value }) => {
      resolve.mutate(value.userCode, {
        onSuccess: (details) => {
          if (details.status === 'pending') {
            onResolved(details);
            return;
          }
          toast.add({
            type: details.status === 'approved' ? 'success' : 'error',
            title: terminalMessage(details.status),
          });
        },
      });
    },
  });
  useEffect(() => {
    const code = new URLSearchParams(window.location.hash.slice(1)).get('code');
    if (code !== null) form.setFieldValue('userCode', normalizeAgentUserCode(code));
    if (window.location.hash !== '')
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }, [form]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <AgentAuthorizationCard description={m['dashboard.agent_authorization.instructions']()}>
        <CardContent>
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
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={resolve.isPending}>
            {m['dashboard.agent_authorization.resolve']()}
          </Button>
        </CardFooter>
      </AgentAuthorizationCard>
    </form>
  );
};
