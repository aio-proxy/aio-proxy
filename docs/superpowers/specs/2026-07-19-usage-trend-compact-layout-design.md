# Usage Trend Compact Layout Design

## Goal

Reduce the vertical footprint of the dashboard Usage trend card and replace the visually disconnected metric and grouping controls with one compact, coherent toolbar.

## Scope

- Update only the Usage trend chart and its header controls.
- Preserve metric and grouping state, data requests, chart semantics, copy, theme tokens, keyboard behavior, and ARIA labels.
- Do not change the global appearance of unrelated tabs.

## Layout

- Keep the title and description on the left of the card header.
- Place the metric group (`Cost`, `Tokens`, `Requests`) and grouping group (`Model`, `Provider`) together on the right as one compact toolbar.
- Keep each logical group intact. On wide screens both groups appear on one row; when space is insufficient, wrap between the groups rather than inside a group.
- Reduce the toolbar control height from approximately 36px to 32px while retaining comfortable pointer targets and visible keyboard focus.

## Chart Density

- Remove the chart's width-driven 16:9 sizing behavior.
- Use an explicit responsive height: approximately 256px on mobile and 288px from the small breakpoint upward.
- Preserve axis labels, tooltip, legend, stacked area rendering, and chart accessibility relationships.

## Visual Direction

- Reuse the dashboard's semantic background, foreground, muted, border, and focus-ring tokens; introduce no new palette or typography.
- Make the combined toolbar the single visual signature: a quiet, cohesive command strip rather than two large floating pills.
- Keep the rest of the card restrained so the data remains primary.

## Responsive and Accessibility Behavior

- At narrow widths, the header stacks below the title and the two control groups may wrap as complete units.
- Individual groups remain horizontally scrollable only if the viewport is narrower than the group itself.
- Existing Base UI tab semantics, active state, focus visibility, disabled behavior, and localized ARIA labels remain unchanged.

## Verification

- Build/check the affected dashboard package.
- Exercise the Usage page in a browser at desktop and mobile widths.
- Confirm chart heights, control alignment and wrapping, active states, focus behavior, tooltip/legend readability, and absence of horizontal page overflow.
