# Usage Trend Compact Layout Design

## Goal

Reduce the vertical footprint of the dashboard usage chart and make the grouping choice part of the chart title instead of a second control floating beside the metric selector.

## Scope

- Update only the Usage trend chart and its header controls.
- Preserve metric and grouping state, data requests, chart semantics, existing description and metric copy, theme tokens, keyboard behavior, and ARIA labels.
- Do not change the global appearance of unrelated tabs.

## Layout

- Replace the static `Usage trend` title with grouping title tabs: `Model usage` / `Provider usage` in English and `模型用量` / `提供商用量` in Simplified Chinese.
- Use the shared `TabsList` line variant for the grouping title tabs so they read as the card heading without introducing local trigger padding or sizing.
- Keep the metric group (`Cost`, `Tokens`, `Requests`) on the right using the shared default tabs appearance without local trigger styling overrides.
- Keep each logical group intact. On narrow screens, stack the grouping title tabs above the metric tabs rather than splitting options within either group.

## Chart Density

- Remove the chart's width-driven 16:9 sizing behavior.
- Use an explicit responsive height: approximately 256px on mobile and 288px from the small breakpoint upward.
- Preserve axis labels, tooltip, legend, stacked area rendering, and chart accessibility relationships.

## Visual Direction

- Reuse the dashboard's semantic background, foreground, muted, border, and focus-ring tokens; introduce no new palette or typography.
- Make the grouping title tabs the single visual signature: the card identifies and switches between model and provider usage in the same place.
- Keep the rest of the card restrained so the data remains primary.

## Responsive and Accessibility Behavior

- At narrow widths, the header stacks the grouping title tabs and description above the metric tabs.
- Individual groups remain horizontally scrollable only if the viewport is narrower than the group itself.
- Existing Base UI tab semantics, active state, focus visibility, disabled behavior, and localized ARIA labels remain unchanged.

## Verification

- Build/check the affected dashboard package.
- Exercise the Usage page in a browser at desktop and mobile widths.
- Confirm chart heights, control alignment and wrapping, active states, focus behavior, tooltip/legend readability, and absence of horizontal page overflow.
