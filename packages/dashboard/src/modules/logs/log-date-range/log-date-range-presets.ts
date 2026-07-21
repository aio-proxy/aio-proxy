import { m } from "@aio-proxy/i18n";
import { endOfMinute } from "date-fns";

import type { DateTimeRangePreset } from "@/components/date-time-range-picker";

const resolveMinutes = (minutes: number, now: Date) => {
  const to = endOfMinute(now);
  return { from: new Date(to.getTime() - minutes * 60_000 + 1), to };
};

export const createLogsDateTimeRangePresets = (): DateTimeRangePreset[] => [
  { id: "15m", label: m["dashboard.logs.range_15m"](), resolve: (now) => resolveMinutes(15, now) },
  { id: "1h", label: m["dashboard.logs.range_1h"](), resolve: (now) => resolveMinutes(60, now) },
  { id: "3h", label: m["dashboard.logs.range_3h"](), resolve: (now) => resolveMinutes(180, now) },
  { id: "6h", label: m["dashboard.logs.range_6h"](), resolve: (now) => resolveMinutes(360, now) },
  { id: "12h", label: m["dashboard.logs.range_12h"](), resolve: (now) => resolveMinutes(720, now) },
  { id: "24h", label: m["dashboard.logs.range_24h"](), resolve: (now) => resolveMinutes(1_440, now) },
  { id: "3d", label: m["dashboard.logs.range_3d"](), resolve: (now) => resolveMinutes(4_320, now) },
  { id: "7d", label: m["dashboard.logs.range_7d"](), resolve: (now) => resolveMinutes(10_080, now) },
];
