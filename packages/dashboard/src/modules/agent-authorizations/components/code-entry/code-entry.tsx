import { m } from '@aio-proxy/i18n';
import type { AgentAuthorizationDetails } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { CardContent, CardFooter } from '@aio-proxy/ui/components/card';
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
import { toast } from '@aio-proxy/ui/components/toast';
import { useForm } from '@tanstack/react-form';
import { Clock, Fingerprint, List, Sparkles, Tag, User } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { useAgentAuthorization } from '../../hooks/use-agent-authorization';
import { normalizeAgentUserCode } from '../../lib/user-code';
import { AgentAuthorizationRequestError } from '../../services/agent-authorizations-service';
import { Card } from '../card';
import { Result } from '../result';

const codeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
const otpSlots = [0, 1, 2, 3, 4, 5, 6, 7] as const;

type PendingAuthorization = Extract<AgentAuthorizationDetails, { status: 'pending' }>;
type TerminalStatus = Exclude<AgentAuthorizationDetails['status'], 'pending'>;

const terminalMessage = (status: TerminalStatus): string => {
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

const reportTerminal = (status: TerminalStatus): void => {
  toast.add({
    type: status === 'approved' ? 'success' : 'error',
    title: terminalMessage(status),
  });
};

// Captured before the mount effect strips the hash, so a link code never flashes the entry step.
const linkCodeFromLocation = (): string | undefined => {
  const code = new URLSearchParams(window.location.hash.slice(1)).get('code');
  if (code === null) return undefined;
  const normalized = normalizeAgentUserCode(code);
  return codeSchema.safeParse(normalized).success ? normalized : undefined;
};

export const CodeEntry: React.FC = () => {
  const { resolve, approve, deny } = useAgentAuthorization();
  const resolveCode = resolve.mutate;
  const [linkCode] = useState<string | undefined>(linkCodeFromLocation);
  const [submittedCode, setSubmittedCode] = useState<string>();
  const [pending, setPending] = useState<PendingAuthorization>();
  const linkResolveStarted = useRef(false);
  const form = useForm({
    defaultValues: { userCode: '' },
    onSubmit: ({ value }) => {
      resolveCode(value.userCode, {
        onSuccess: (details) => {
          if (details.status !== 'pending') {
            reportTerminal(details.status);
            return;
          }
          setSubmittedCode(value.userCode);
          setPending(details);
        },
      });
    },
  });

  useEffect(() => {
    const raw = new URLSearchParams(window.location.hash.slice(1)).get('code');
    if (raw !== null && linkCode === undefined) form.setFieldValue('userCode', normalizeAgentUserCode(raw));
    if (window.location.hash !== '')
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    if (linkCode === undefined || linkResolveStarted.current) return;
    linkResolveStarted.current = true;
    resolveCode(linkCode, {
      onSuccess: (details) => {
        if (details.status === 'pending') {
          setPending(details);
          return;
        }
        reportTerminal(details.status);
      },
    });
  }, [form, linkCode, resolveCode]);

  const decision = approve.data ?? deny.data;
  if (decision !== undefined) return <Result status={decision.status} />;

  const knownCode = submittedCode ?? linkCode;
  const showRequest = knownCode !== undefined && (linkCode !== undefined || pending !== undefined);
  if (!showRequest || knownCode === undefined) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <Card description={m['dashboard.agent_authorization.instructions']()}>
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
        </Card>
      </form>
    );
  }

  const error = approve.error ?? deny.error ?? resolve.error;
  const rows =
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

  return (
    <Card description={pending === undefined ? undefined : m['dashboard.agent_authorization.pending']()}>
      <CardContent className="flex flex-col gap-6">
        <p
          aria-label={m['dashboard.agent_authorization.code_label']()}
          className="text-center text-2xl font-semibold tracking-widest"
        >
          {knownCode}
        </p>
        {rows.length === 0 ? null : (
          <section aria-label={m['dashboard.agent_authorization.permissions_title']()}>
            <ItemGroup className="gap-0">
              {rows.map((row, index) => {
                const Icon = row.icon;
                return (
                  <Fragment key={row.label}>
                    <Item size="xs">
                      <ItemMedia variant="icon">
                        <Icon />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{row.label}</ItemTitle>
                      </ItemContent>
                      {row.value === undefined ? null : (
                        <ItemContent>
                          <ItemDescription>{row.value}</ItemDescription>
                        </ItemContent>
                      )}
                    </Item>
                    {index === rows.length - 1 ? null : <ItemSeparator className="my-0" />}
                  </Fragment>
                );
              })}
            </ItemGroup>
          </section>
        )}
        {error === null || error === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {requestErrorMessage(error)}
          </p>
        )}
      </CardContent>
      {pending === undefined ? null : (
        <CardFooter className="justify-end gap-2">
          <Button
            variant="outline"
            disabled={approve.isPending || deny.isPending}
            onClick={() => deny.mutate(pending.deviceId)}
          >
            {m['dashboard.agent_authorization.deny']()}
          </Button>
          <Button disabled={approve.isPending || deny.isPending} onClick={() => approve.mutate(pending.deviceId)}>
            {m['dashboard.agent_authorization.approve']()}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
};
