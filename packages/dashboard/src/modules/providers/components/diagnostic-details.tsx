import type { Diagnostic } from "@aio-proxy/types";
import type React from "react";

type Props = {
  readonly diagnostic: Diagnostic;
  readonly suggestedCommand?: string;
};

export const DiagnosticDetails: React.FC<Props> = ({ diagnostic, suggestedCommand }) => (
  <div className="space-y-1 text-xs">
    <div>{diagnostic.summary}</div>
    <div className="text-muted-foreground">{diagnostic.code}</div>
    {suggestedCommand === undefined ? null : <code className="block whitespace-normal">{suggestedCommand}</code>}
  </div>
);
