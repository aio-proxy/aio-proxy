import { AioProxyLogo } from '@aio-proxy/brand';
import { m } from '@aio-proxy/i18n';
import type { AgentAuthorizationDetails } from '@aio-proxy/types';
import { Alert, AlertDescription } from '@aio-proxy/ui/components/alert';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Field, FieldError, FieldLabel } from '@aio-proxy/ui/components/field';
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@aio-proxy/ui/components/input-otp';
import { toast } from '@aio-proxy/ui/components/toast';
import { useForm } from '@tanstack/react-form';
import { Clock, Fingerprint, List, Sparkles, Tag, User } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { useAgentAuthorization } from '../../hooks/use-agent-authorization';
import { normalizeAgentUserCode } from '../../lib/user-code';
import { AgentAuthorizationRequestError } from '../../services/agent-authorizations-service';
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

const reportTerminal = (status: TerminalStatus): void => {
  toast.add({
    type: status === 'approved' ? 'success' : 'error',
    title: terminalMessage(status),
  });
};

// Captured before the mount effect strips the hash, so a link code is pre-filled without flashing an empty entry.
const linkCodeFromLocation = (): string | undefined => {
  const code = new URLSearchParams(window.location.hash.slice(1)).get('code');
  if (code === null) return undefined;
  const normalized = normalizeAgentUserCode(code);
  return codeSchema.safeParse(normalized).success ? normalized : undefined;
};

export const CodeEntry: React.FC = () => {
  const { resolve, approve, deny } = useAgentAuthorization();
  const [linkCode] = useState<string | undefined>(linkCodeFromLocation);
  // The resolved challenge is only offered for the code still in the entry, so editing the code returns the screen to entry mode.
  const [pending, setPending] = useState<{ readonly code: string; readonly details: PendingAuthorization }>();
  // The footer buttons record their decision here before submitting; the auto-resolve and a bare Enter submit resolve only.
  const selectedAction = useRef<'resolve' | 'approve' | 'deny'>('resolve');
  // The last complete code handed to the resolver, so auto-resolve fires once per code.
  const autoResolved = useRef('');
  const form = useForm({
    defaultValues: { userCode: linkCode ?? '' },
    onSubmit: async ({ value }) => {
      const action = selectedAction.current;
      selectedAction.current = 'resolve';
      let details: PendingAuthorization | undefined;
      if (action !== 'resolve' && pending !== undefined && pending.code === value.userCode) {
        // Deciding reuses the reviewed challenge; resolving it again would spend a second rate-limited
        // slot (10 per minute per peer) for information the panel already holds.
        details = pending.details;
      } else {
        try {
          const resolved = await resolve.mutateAsync(value.userCode);
          if (resolved.status !== 'pending') {
            setPending(undefined);
            reportTerminal(resolved.status);
            return;
          }
          details = resolved;
          setPending({ code: value.userCode, details: resolved });
        } catch {
          // A failed resolve must not lock the code out of a retry; the alert invites trying again.
          autoResolved.current = '';
          // resolve.error renders the alert below the entry
          return;
        }
      }
      if (action === 'resolve') return;
      try {
        await (action === 'approve' ? approve : deny).mutateAsync(details.deviceId);
      } catch {
        // The decision error renders the alert; the entry stays for a retry
      }
    },
  });

  const autoResolve = (code: string): void => {
    if (!codeSchema.safeParse(code).success) {
      autoResolved.current = '';
      return;
    }
    if (autoResolved.current === code || resolve.isPending) return;
    autoResolved.current = code;
    selectedAction.current = 'resolve';
    void form.handleSubmit();
  };

  useEffect(() => {
    const raw = new URLSearchParams(window.location.hash.slice(1)).get('code');
    if (raw === null) return;
    const normalized = normalizeAgentUserCode(raw);
    if (linkCode === undefined) form.setFieldValue('userCode', normalized);
    if (window.location.hash !== '')
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    // A URL code is only pre-filled; the same auto-resolve flow applies as to typed codes.
    autoResolve(normalized);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, linkCode]);

  const submitDecision = (action: 'approve' | 'deny'): void => {
    if (resolve.isPending) return;
    selectedAction.current = action;
    void form.handleSubmit();
  };

  const decision = approve.data ?? deny.data;
  if (decision !== undefined) return <Result status={decision.status} />;

  const error = approve.error ?? deny.error ?? resolve.error;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <Card className="mb-16 w-full max-w-sm">
        <form.Subscribe selector={(state) => state.values.userCode}>
          {(inputCode) => {
            const details = pending !== undefined && pending.code === inputCode ? pending.details : undefined;
            const complete = codeSchema.safeParse(inputCode).success;
            const busy = resolve.isPending || approve.isPending || deny.isPending;
            const decideDisabled = !complete || busy;
            return (
              <>
                <CardHeader>
                  <CardTitle>
                    <h1 className="flex items-center gap-2 text-xl font-semibold">
                      {m['dashboard.agent_authorization.title']()}
                      <AioProxyLogo className="text-xl" />
                    </h1>
                  </CardTitle>
                  <CardDescription>
                    {details === undefined
                      ? m['dashboard.agent_authorization.instructions']()
                      : m['dashboard.agent_authorization.pending']()}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                  {details === undefined ? null : (
                    <section className="flex flex-col gap-3">
                      <h2 className="text-sm font-medium">{m['dashboard.agent_authorization.permissions_title']()}</h2>
                      {[
                        { icon: User, label: m['dashboard.agent_authorization.target'](), value: details.target },
                        {
                          icon: Fingerprint,
                          label: m['dashboard.agent_authorization.installation'](),
                          value: details.installationId,
                        },
                        {
                          icon: Tag,
                          label: m['dashboard.agent_authorization.version'](),
                          value: details.adapterVersion,
                        },
                        {
                          icon: Clock,
                          label: m['dashboard.agent_authorization.expires'](),
                          value: new Date(details.expiresAt).toLocaleString(),
                        },
                        { icon: List, label: m['dashboard.agent_authorization.permission_catalog']() },
                        { icon: Sparkles, label: m['dashboard.agent_authorization.permission_inference']() },
                      ].map((row) => {
                        const Icon = row.icon;
                        return (
                          <div key={row.label} className="flex flex-col gap-0.5">
                            <div
                              className={
                                row.value === undefined
                                  ? 'flex items-center gap-1.5 text-sm'
                                  : 'flex items-center gap-1.5 text-xs text-muted-foreground'
                              }
                            >
                              <Icon className="size-3.5 shrink-0" />
                              <span className="break-words">{row.label}</span>
                            </div>
                            {row.value === undefined ? null : <div className="text-sm break-words">{row.value}</div>}
                          </div>
                        );
                      })}
                    </section>
                  )}
                  {error === null || error === undefined ? null : (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {typeof AgentAuthorizationRequestError === 'function' &&
                        error instanceof AgentAuthorizationRequestError &&
                        error.code === 'authorization_unavailable'
                          ? m['dashboard.agent_authorization.password_required']()
                          : m['dashboard.agent_authorization.network_error']()}
                      </AlertDescription>
                    </Alert>
                  )}
                  <form.Field
                    name="userCode"
                    validators={{
                      onSubmit: ({ value }) =>
                        codeSchema.safeParse(value).success
                          ? undefined
                          : m['dashboard.agent_authorization.code_invalid'](),
                    }}
                  >
                    {(field) => (
                      <Field data-invalid={field.state.meta.errors.length > 0 || undefined}>
                        <FieldLabel className="mx-auto" htmlFor="agent-user-code">
                          {m['dashboard.agent_authorization.code_label']()}
                        </FieldLabel>
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
                            onChange={(value) => {
                              const previous = field.state.value;
                              const normalized = normalizeAgentUserCode(value);
                              field.handleChange(normalized);
                              // A decision error belongs to the challenge it was decided against; a new code
                              // starts a new lifecycle and must not inherit the old alert.
                              if (previous !== normalized && !approve.isPending && !deny.isPending) {
                                if (approve.error !== null) approve.reset();
                                if (deny.error !== null) deny.reset();
                              }
                              autoResolve(normalized);
                            }}
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
                </CardContent>
                <CardFooter className="flex flex-col gap-2">
                  <Button
                    className="w-full"
                    type="button"
                    disabled={decideDisabled}
                    onClick={() => submitDecision('approve')}
                  >
                    {m['dashboard.agent_authorization.approve']()}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    type="button"
                    disabled={decideDisabled}
                    onClick={() => submitDecision('deny')}
                  >
                    {m['dashboard.agent_authorization.deny']()}
                  </Button>
                </CardFooter>
              </>
            );
          }}
        </form.Subscribe>
      </Card>
    </form>
  );
};
