import { AioProxyLogo } from '@aio-proxy/brand';
import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Field, FieldError } from '@aio-proxy/ui/components/field';
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@aio-proxy/ui/components/input-otp';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '@aio-proxy/ui/components/item';
import { useForm } from '@tanstack/react-form';
import { Clock, Fingerprint, List, Sparkles, Tag, User } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { z } from 'zod';

import { useAgentAuthorization } from '../../hooks/use-agent-authorization';
import { normalizeAgentUserCode } from '../../lib/user-code';
import { AgentAuthorizationRequestError } from '../../services/agent-authorizations-service';

const codeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
const otpSlots = [0, 1, 2, 3, 4, 5, 6, 7] as const;
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
  const details =
    pending === undefined
      ? []
      : [
          { icon: User, label: m['dashboard.agent_authorization.target'](), value: pending.target },
          {
            icon: Fingerprint,
            label: m['dashboard.agent_authorization.installation'](),
            value: pending.installationId,
          },
          { icon: Tag, label: m['dashboard.agent_authorization.version'](), value: pending.adapterVersion },
          {
            icon: Clock,
            label: m['dashboard.agent_authorization.expires'](),
            value: new Date(pending.expiresAt).toLocaleString(),
          },
          { icon: List, label: m['dashboard.agent_authorization.permission_catalog']() },
          { icon: Sparkles, label: m['dashboard.agent_authorization.permission_inference']() },
        ];

  const codeEntry = result === undefined;
  const alert =
    error === null || error === undefined ? null : (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage}
      </p>
    );

  return (
    <main className="flex min-h-dvh items-center justify-center bg-sidebar px-4 py-8">
      <Card className="w-full max-w-sm" size="sm">
        <CardHeader className={codeEntry ? 'text-center' : undefined}>
          <CardTitle>
            <h1 className={`flex items-center gap-2 text-xl font-semibold ${codeEntry ? 'justify-center' : ''}`}>
              {m['dashboard.agent_authorization.title']()}
              <AioProxyLogo className="text-xl" />
            </h1>
          </CardTitle>
          {codeEntry ? <CardDescription>{m['dashboard.agent_authorization.instructions']()}</CardDescription> : null}
          {pending === undefined ? null : (
            <CardDescription>{m['dashboard.agent_authorization.pending']()}</CardDescription>
          )}
        </CardHeader>

        {codeEntry ? (
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
              {alert}
              <Button type="submit" disabled={isPending}>
                {m['dashboard.agent_authorization.resolve']()}
              </Button>
            </form>
          </CardContent>
        ) : null}

        {pending === undefined ? null : (
          <CardContent>
            <section aria-label={m['dashboard.agent_authorization.permissions_title']()}>
              <ItemGroup className="gap-0">
                {details.map((detail, index) => {
                  const Icon = detail.icon;
                  return (
                    <Fragment key={detail.label}>
                      <Item size="xs">
                        <ItemMedia variant="icon">
                          <Icon />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>{detail.label}</ItemTitle>
                        </ItemContent>
                        {detail.value === undefined ? null : (
                          <ItemContent>
                            <ItemDescription>{detail.value}</ItemDescription>
                          </ItemContent>
                        )}
                      </Item>
                      {index === details.length - 1 ? null : <ItemSeparator className="my-0" />}
                    </Fragment>
                  );
                })}
              </ItemGroup>
            </section>
          </CardContent>
        )}
        {pending === undefined ? null : (
          <CardFooter className="justify-end gap-2">
            <Button variant="outline" disabled={isPending} onClick={() => authorization.deny.mutate(pending.deviceId)}>
              {m['dashboard.agent_authorization.deny']()}
            </Button>
            <Button disabled={isPending} onClick={() => authorization.approve.mutate(pending.deviceId)}>
              {m['dashboard.agent_authorization.approve']()}
            </Button>
          </CardFooter>
        )}

        {result !== undefined && result.status !== 'pending' ? (
          <CardContent>
            <p role="status">{terminalMessage(result.status)}</p>
          </CardContent>
        ) : null}
        {result !== undefined && result.status !== 'pending' ? (
          <CardFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDismissed(true);
                authorization.reset();
              }}
            >
              {m['dashboard.agent_authorization.retry']()}
            </Button>
          </CardFooter>
        ) : null}
        {codeEntry || alert === null ? null : <CardContent>{alert}</CardContent>}
      </Card>
    </main>
  );
};
