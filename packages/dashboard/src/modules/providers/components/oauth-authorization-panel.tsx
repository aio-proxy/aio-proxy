import type { DashboardOAuthSession } from "@aio-proxy/types";

import { m } from "@aio-proxy/i18n";
import { useForm } from "@tanstack/react-form";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

interface OAuthAuthorizationPanelProps {
  readonly session: DashboardOAuthSession;
  readonly onSubmitCallback: (callbackUrl: string) => void;
  readonly onCancel: () => void;
  readonly isPending: boolean;
}

export const OAuthAuthorizationPanel: React.FC<OAuthAuthorizationPanelProps> = ({
  session,
  onSubmitCallback,
  onCancel,
  isPending,
}) => {
  const callbackForm = useForm({
    defaultValues: { callbackUrl: "" },
    onSubmit: ({ value }) => {
      onSubmitCallback(value.callbackUrl);
      callbackForm.reset();
    },
  });

  return (
    <div className="space-y-4 rounded-lg border p-4">
      {session.status === "preparing" || session.status === "discovering" ? (
        <div className="flex items-center gap-2">
          <Spinner /> {m["dashboard.providers.oauth.preparing"]()}
        </div>
      ) : null}
      {session.status === "device_code" ? (
        <div className="space-y-3">
          <h2 className="font-semibold">{m["dashboard.providers.oauth.device_code_title"]()}</h2>
          <code className="block text-lg">{session.userCode}</code>
          <Button nativeButton={false} render={<a href={session.url} target="_blank" rel="noreferrer" />}>
            {m["dashboard.providers.oauth.open_authorization"]()}
          </Button>
        </div>
      ) : null}
      {session.status === "loopback" ? (
        <div className="space-y-3">
          <h2 className="font-semibold">{m["dashboard.providers.oauth.loopback_title"]()}</h2>
          <Button nativeButton={false} render={<a href={session.authorizationUrl} target="_blank" rel="noreferrer" />}>
            {m["dashboard.providers.oauth.open_authorization"]()}
          </Button>
          {session.allowManualCallback ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void callbackForm.handleSubmit();
              }}
            >
              <callbackForm.Field name="callbackUrl">
                {(field) => (
                  <Field>
                    <Label htmlFor={field.name}>{m["dashboard.providers.oauth.manual_callback_label"]()}</Label>
                    <Input
                      id={field.name}
                      value={field.state.value}
                      placeholder={m["dashboard.providers.oauth.manual_callback_placeholder"]()}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                  </Field>
                )}
              </callbackForm.Field>
              <Button type="submit" disabled={isPending}>
                {m["dashboard.providers.oauth.submit_callback"]()}
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
      {session.status === "failed" ? (
        <p className="text-destructive">
          {session.code === "OAUTH_SESSION_UNAVAILABLE"
            ? m["dashboard.providers.oauth.session_unavailable"]()
            : session.code === "PROVIDER_FINGERPRINT_MISMATCH"
              ? m["dashboard.providers.oauth.fingerprint_mismatch"]()
              : m["dashboard.providers.oauth.failed"]({ code: session.code })}
        </p>
      ) : null}
      {session.status === "cancelled" ? <p>{m["dashboard.providers.oauth.authorization_cancelled"]()}</p> : null}
      {session.status === "succeeded" && session.duplicate ? <p>{m["dashboard.providers.oauth.duplicate"]()}</p> : null}
      {session.status === "succeeded" && session.warning === "catalog_unavailable" ? (
        <p>{m["dashboard.providers.oauth.catalog_warning"]()}</p>
      ) : null}
      {session.status === "preparing" ||
      session.status === "device_code" ||
      session.status === "loopback" ||
      session.status === "discovering" ? (
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          {m["dashboard.providers.oauth.cancel"]()}
        </Button>
      ) : null}
      {session.status === "failed" || session.status === "cancelled" ? (
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          {m["dashboard.providers.oauth.start_over"]()}
        </Button>
      ) : null}
    </div>
  );
};
