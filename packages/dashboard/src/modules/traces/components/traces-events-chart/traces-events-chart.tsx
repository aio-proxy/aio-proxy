import { getLocale, m } from '@aio-proxy/i18n';
import type { DashboardTraceSummaryBucket, DashboardTraceSummaryBucketSize } from '@aio-proxy/types';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@aio-proxy/ui/components/chart';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

interface TracesEventsChartProps {
  readonly buckets: readonly DashboardTraceSummaryBucket[];
  readonly bucket: DashboardTraceSummaryBucketSize;
  readonly onBucketSelect: (at: string) => void;
}

export const TracesEventsChart: React.FC<TracesEventsChartProps> = ({ buckets, bucket, onBucketSelect }) => {
  const locale = getLocale();
  const formatCount = new Intl.NumberFormat(locale, { notation: 'compact' });
  const formatTick =
    bucket === '1d'
      ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
      : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const formatLabel = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const chartConfig = {
    success: { color: 'var(--chart-success)', label: m['dashboard.traces.success']() },
    error: { color: 'var(--chart-error)', label: m['dashboard.traces.failure']() },
  } satisfies ChartConfig;

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-40 w-full">
      <BarChart
        data={buckets as DashboardTraceSummaryBucket[]}
        margin={{ left: 8, right: 8 }}
        barCategoryGap={2}
        maxBarSize={24}
        onClick={(state) => {
          // activeLabel 是命中那一类的 x 值，也就是桶的 at。事件挂在图上而不是 <Bar> 上，
          // 空桶（一条都没有）也点得到 —— 命中区是整条类目带，比柱体本身宽。
          if (typeof state.activeLabel === 'string') onBucketSelect(state.activeLabel);
        }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="at"
          axisLine={false}
          tickLine={false}
          minTickGap={24}
          tickFormatter={(value) => formatTick.format(new Date(String(value)))}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          width={40}
          tickFormatter={(value) => formatCount.format(Number(value))}
        />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={(value) => formatLabel.format(new Date(String(value)))} />}
        />
        {/* 成功在下、失败在上。stroke 用页面底色画 2px，既是堆叠两段之间的表面间隙，
            也把相邻柱子分开。卡片挂在 SidebarInset 里，那层写死了 bg-background，
            外面 <Card> 的 bg-card 到不了这里 —— 描边必须跟 --background 同色，
            不然暗色下 olive-900 描在 olive-950 上会给每根柱子镶一圈亮边。
            两段都收 4px 圆角：绝大多数桶没有失败，只给顶段加圆角的话
            整张图会变成一排平头柱子。有失败时成功段顶上那两个圆角缺口正好落在 2px 间隙里。 */}
        <Bar
          dataKey="success"
          stackId="events"
          fill="var(--chart-success)"
          stroke="var(--background)"
          strokeWidth={2}
          radius={[4, 4, 0, 0]}
          className="cursor-pointer"
        />
        <Bar
          dataKey="error"
          stackId="events"
          fill="var(--chart-error)"
          stroke="var(--background)"
          strokeWidth={2}
          radius={[4, 4, 0, 0]}
          className="cursor-pointer"
        />
      </BarChart>
    </ChartContainer>
  );
};
