import { m } from "@aio-proxy/i18n";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const DashboardUnavailable: React.FC = () => (
  <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8">
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl font-semibold text-balance">{m["dashboard.auth.unavailable.title"]()}</h1>
        </CardTitle>
        <CardDescription className="max-w-[65ch] text-pretty">
          {m["dashboard.auth.unavailable.description"]()}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="outline" onClick={() => window.location.reload()}>
          {m["dashboard.auth.unavailable.reload"]()}
        </Button>
      </CardContent>
    </Card>
  </main>
);
