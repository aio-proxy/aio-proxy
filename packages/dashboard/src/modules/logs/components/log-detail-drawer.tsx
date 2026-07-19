import type { DashboardRequestLog, RequestOutcome } from "@aio-proxy/types";
import type { ReactNode } from "react";

import { m } from "@aio-proxy/i18n";
import { Clipboard } from "lucide-react";

import { ProtocolLabel } from "@/components/protocol-label";
import { TokenCount } from "@/components/token-count";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ScrollArea } from "@/components/ui/scroll-area";

import { displayTotalTokens, formatDuration, formatLogCost } from "../log-formatters";

type Props = { readonly log: DashboardRequestLog | undefined; readonly onClose: () => void };

const renderTokenCount = (value: number | undefined) =>
  value === undefined ? undefined : <TokenCount value={value} />;

export const LogDetailDrawer: React.FC<Props> = ({ log, onClose }) => {
  const missing = m["dashboard.logs.not_available"]();
  const outcomeLabel = (outcome: RequestOutcome) => m[`dashboard.logs.${outcome}`]();
  const rows: readonly (readonly [string, ReactNode])[] = log
    ? [
        [m["dashboard.logs.outcome"](), outcomeLabel(log.outcome)],
        [m["dashboard.logs.protocol"](), <ProtocolLabel key="inbound-protocol" protocol={log.inboundProtocol} />],
        [m["dashboard.logs.requested_model"](), log.requestedModelId],
        [m["dashboard.logs.final_provider"](), log.finalProviderId],
        [m["dashboard.logs.final_model"](), log.finalModelId],
        [m["dashboard.logs.status"](), log.finalStatusCode],
        [m["dashboard.logs.error_code"](), log.errorCode],
        [m["dashboard.logs.started_at"](), new Date(log.startedAt).toLocaleString()],
        [m["dashboard.logs.completed_at"](), new Date(log.completedAt).toLocaleString()],
        [m["dashboard.logs.duration"](), formatDuration(log.durationMs)],
      ]
    : [];
  const usageRows: readonly (readonly [string, ReactNode])[] = log
    ? [
        [m["dashboard.logs.usage_provider"](), log.usage?.providerId],
        [m["dashboard.logs.usage_model"](), log.usage?.modelId],
        [m["dashboard.logs.input_tokens"](), renderTokenCount(log.usage?.inputTokens)],
        [m["dashboard.logs.output_tokens"](), renderTokenCount(log.usage?.outputTokens)],
        [m["dashboard.logs.tokens"](), renderTokenCount(displayTotalTokens(log.usage))],
        [m["dashboard.logs.cache_read_tokens"](), renderTokenCount(log.usage?.cacheReadTokens)],
        [m["dashboard.logs.cache_write_tokens"](), renderTokenCount(log.usage?.cacheWriteTokens)],
        [m["dashboard.logs.reasoning_tokens"](), renderTokenCount(log.usage?.reasoningTokens)],
        [m["dashboard.logs.cost"](), formatLogCost(log.usage?.estimatedCostUsd)],
      ]
    : [];
  return (
    <Drawer
      open={log !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      swipeDirection="right"
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{m["dashboard.logs.details"]()}</DrawerTitle>
          <DrawerDescription>{log?.requestId}</DrawerDescription>
        </DrawerHeader>
        {log && (
          <ScrollArea className="min-h-0 flex-1 p-4">
            <div className="space-y-5">
              <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(log.requestId)}>
                <Clipboard />
                {m["dashboard.logs.copy_id"]()}
              </Button>
              {[
                [m["dashboard.logs.summary"](), rows],
                [m["dashboard.logs.usage"](), usageRows],
              ].map(([title, items]) => (
                <section key={title as string}>
                  <h3 className="mb-2 font-medium">{title as string}</h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    {(items as typeof rows).map(([label, value]) => (
                      <div className="contents" key={label}>
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="min-w-0 text-right wrap-break-word">
                          {value === undefined || value === null ? missing : value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
              <section>
                <h3 className="mb-2 font-medium">{m["dashboard.logs.attempts"]()}</h3>
                <div className="space-y-2">
                  {log.attempts.map((attempt) => (
                    <div className="rounded-xl border p-3 text-sm" key={attempt.index}>
                      <div className="font-medium">
                        #{attempt.index + 1} · {attempt.providerId} / {attempt.modelId}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-1 text-muted-foreground">
                        <span>{attempt.providerKind}</span>
                        <span>·</span>
                        {attempt.protocol === undefined ? missing : <ProtocolLabel protocol={attempt.protocol} />}
                        <span>·</span>
                        <span>{outcomeLabel(attempt.outcome)}</span>
                        <span>·</span>
                        <span>{attempt.statusCode ?? missing}</span>
                        <span>·</span>
                        <span>{formatDuration(attempt.durationMs)}</span>
                        {attempt.errorCode ? (
                          <>
                            <span>·</span>
                            <span>{attempt.errorCode}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </ScrollArea>
        )}
        <DrawerFooter>
          <DrawerClose render={<Button variant="outline" />}>{m["dashboard.logs.close"]()}</DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
};
