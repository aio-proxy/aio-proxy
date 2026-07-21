import { m } from "@aio-proxy/i18n";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { z } from "zod";

import { AioProxyBrand } from "@/components/aio-proxy-brand";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

import { loginDashboard, type DashboardLoginResult } from "../services/auth-service";

interface LoginPageProps {
  readonly reason?: "expired";
}

const passwordSchema = z.string().min(1);

export const LoginPage: React.FC<LoginPageProps> = ({ reason }) => {
  const [error, setError] = useState<Exclude<DashboardLoginResult, { readonly ok: true }>["error"]>();
  const form = useForm({
    defaultValues: { password: "" },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const result = await loginDashboard(value.password);
      if (!result.ok) setError(result.error);
    },
  });

  return (
    <main className="flex min-h-dvh items-center justify-center bg-sidebar px-4 py-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-4">
            <AioProxyBrand logoHeight="32px" showTagline={false} />
          </div>
          <CardTitle>
            <h1 className="text-xl font-semibold text-balance">{m["dashboard.auth.login.title"]()}</h1>
          </CardTitle>
          <CardDescription className="text-pretty">{m["dashboard.auth.login.description"]()}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            {reason === "expired" ? (
              <p role="status" className="text-sm text-foreground">
                {m["dashboard.auth.login.expired"]()}
              </p>
            ) : null}
            <form.Field
              name="password"
              validators={{
                onSubmit: ({ value }) =>
                  passwordSchema.safeParse(value).success ? undefined : m["dashboard.auth.login.password_required"](),
              }}
            >
              {(field) => (
                <Field data-invalid={field.state.meta.errors.length > 0 || undefined}>
                  <FieldLabel htmlFor="dashboard-password">{m["dashboard.auth.password"]()}</FieldLabel>
                  <Input
                    id="dashboard-password"
                    type="password"
                    autoComplete="current-password"
                    autoFocus
                    aria-invalid={field.state.meta.errors.length > 0 || undefined}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError errors={field.state.meta.errors.map((message) => ({ message: String(message) }))} />
                </Field>
              )}
            </form.Field>
            {error === undefined ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error === "invalid"
                  ? m["dashboard.auth.login.invalid"]()
                  : error === "rate-limited"
                    ? m["dashboard.auth.login.rate_limited"]()
                    : m["dashboard.auth.login.unavailable"]()}
              </p>
            )}
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button className="w-full" type="submit" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? <Spinner /> : null}
                  {m["dashboard.auth.login.submit"]()}
                </Button>
              )}
            </form.Subscribe>
          </form>
        </CardContent>
      </Card>
    </main>
  );
};
