// Static demo behaviour. No build step, no framework — this stands in for the
// recharts/shadcn ChartContainer implementation.

export const theme = () => {
  const saved = localStorage.getItem('demo-theme') ?? 'light';
  document.documentElement.classList.toggle('dark', saved === 'dark');
  document.querySelectorAll('[data-theme-toggle]').forEach((el) => {
    el.addEventListener('click', () => {
      const dark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('demo-theme', dark ? 'dark' : 'light');
      document.dispatchEvent(new CustomEvent('demo:theme'));
    });
  });
};

const rand = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

export const buckets = (count = 60, stepMs = 60_000) => {
  const next = rand(42);
  const end = Date.UTC(2026, 8, 16, 9, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const at = end - (count - 1 - index) * stepMs;
    const base = 18 + Math.round(next() * 26 + Math.sin(index / 6) * 9);
    const error = next() > 0.82 ? Math.round(next() * 7) + 1 : next() > 0.55 ? 1 : 0;
    return { at, success: Math.max(base - error, 1), error };
  });
};

const BAR_GAP = 2; // surface gap between stacked segments and adjacent bars
const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

const niceMax = (value) => {
  const step = NICE.find((candidate) => value / 4 <= candidate) ?? 1000;
  return { max: Math.ceil(value / step) * step, step };
};

export const renderChart = (root, data, series, onPick) => {
  const width = root.clientWidth || 900;
  const height = root.clientHeight || 168;
  const padding = { top: 8, right: 8, bottom: 20, left: 40 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const totals = data.map((d) => (series.success ? d.success : 0) + (series.error ? d.error : 0));
  const { max, step } = niceMax(Math.max(...totals, 1));
  const y = (value) => padding.top + plotH - (value / max) * plotH;
  const slot = plotW / data.length;
  const barW = Math.max(Math.min(slot - BAR_GAP, 24), 2);
  const fmtTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

  const grid = [];
  for (let value = 0; value <= max; value += step) {
    grid.push(`<line x1="${padding.left}" x2="${width - padding.right}" y1="${y(value)}" y2="${y(value)}"/>`);
    grid.push(`<text x="${padding.left - 8}" y="${y(value) + 4}" text-anchor="end">${value}</text>`);
  }

  const bars = data.map((d, index) => {
    const x = padding.left + index * slot + (slot - barW) / 2;
    const parts = [];
    const successH = series.success ? (d.success / max) * plotH : 0;
    const errorH = series.error ? (d.error / max) * plotH : 0;
    // error stacks on top of success; the 2px gap keeps the two fills from touching
    const errorTop = y(0) - successH - (successH && errorH ? BAR_GAP : 0) - errorH;
    if (errorH > 0) {
      parts.push(
        `<path d="${roundedTop(x, errorTop, barW, errorH, Math.min(4, barW / 2, errorH))}" fill="var(--chart-error)"/>`,
      );
    }
    if (successH > 0) {
      const r = errorH > 0 ? 0 : Math.min(4, barW / 2);
      parts.push(
        `<path d="${roundedTop(x, y(0) - successH, barW, successH, r)}" fill="var(--chart-success)"/>`,
      );
    }
    return `<g class="bar-group" data-index="${index}">${parts.join('')}</g>`;
  });

  const bands = data.map(
    (_, index) =>
      `<rect class="band" data-index="${index}" x="${padding.left + index * slot}" y="${padding.top}" width="${slot}" height="${plotH}"/>`,
  );

  const ticks = data
    .map((d, index) => ({ d, index }))
    .filter(({ index }) => index % Math.ceil(data.length / 7) === 0)
    .map(
      ({ d, index }) =>
        `<text x="${padding.left + index * slot + slot / 2}" y="${height - 4}" text-anchor="middle">${fmtTime.format(d.at)}</text>`,
    );

  root.querySelector('svg')?.remove();
  root.insertAdjacentHTML(
    'afterbegin',
    `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="按时间分桶的成功与失败请求数">
      <g class="grid">${grid.filter((_, i) => i % 2 === 0).join('')}</g>
      <g class="axis">${grid.filter((_, i) => i % 2 === 1).join('')}${ticks.join('')}</g>
      ${bars.join('')}
      <g>${bands.join('')}</g>
    </svg>`,
  );

  const tooltip = root.querySelector('.tooltip');
  root.querySelectorAll('.band').forEach((band) => {
    const index = Number(band.dataset.index);
    band.addEventListener('pointerenter', () => {
      band.dataset.hover = 'true';
      const d = data[index];
      tooltip.dataset.open = 'true';
      tooltip.innerHTML = `<div class="tooltip-label">${fmtTime.format(d.at)}</div>
        <div class="tooltip-row"><span class="legend-swatch" style="background:var(--chart-success)"></span><span class="k">成功</span><span class="v">${d.success}</span></div>
        <div class="tooltip-row"><span class="legend-swatch" style="background:var(--chart-error)"></span><span class="k">失败</span><span class="v">${d.error}</span></div>`;
      const x = padding.left + index * slot + slot / 2;
      tooltip.style.left = `${Math.min(Math.max(x - 84, 0), width - 180)}px`;
      tooltip.style.top = `8px`;
    });
    band.addEventListener('pointerleave', () => {
      delete band.dataset.hover;
      tooltip.dataset.open = 'false';
    });
    band.addEventListener('click', () => onPick?.(data[index]));
  });
};

const roundedTop = (x, y, w, h, r) =>
  r <= 0
    ? `M${x} ${y}h${w}v${h}h${-w}z`
    : `M${x} ${y + h}v${-(h - r)}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - r}z`;
