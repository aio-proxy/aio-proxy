import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { CardContent } from '@aio-proxy/ui/components/card';
import { Field, FieldError } from '@aio-proxy/ui/components/field';
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@aio-proxy/ui/components/input-otp';
import { useForm } from '@tanstack/react-form';
import { useEffect } from 'react';
import { z } from 'zod';

import { normalizeAgentUserCode } from '../../lib/user-code';

const codeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
const otpSlots = [0, 1, 2, 3, 4, 5, 6, 7] as const;

interface AgentAuthorizationCodeFormProps {
  readonly disabled: boolean;
  readonly errorMessage: string | undefined;
  readonly onSubmit: (userCode: string) => void;
}

export const AgentAuthorizationCodeForm: React.FC<AgentAuthorizationCodeFormProps> = ({
  disabled,
  errorMessage,
  onSubmit,
}) => {
  const form = useForm({
    defaultValues: { userCode: '' },
    onSubmit: ({ value }) => onSubmit(value.userCode),
  });
  useEffect(() => {
    const code = new URLSearchParams(window.location.hash.slice(1)).get('code');
    if (code !== null) form.setFieldValue('userCode', normalizeAgentUserCode(code));
    if (window.location.hash !== '')
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }, [form]);

  return (
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
        {errorMessage === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        )}
        <Button type="submit" disabled={disabled}>
          {m['dashboard.agent_authorization.resolve']()}
        </Button>
      </form>
    </CardContent>
  );
};
