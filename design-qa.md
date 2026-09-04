# Provider Tier Routing Design QA

## Evidence

- Source visual truth: `/Users/bytedance/.codex/visualizations/2026/09/03/01a067e9-fe18-72a1-8f71-375e3e94c612/priority-routing-demo/tier-flow-final.png`
- Browser-rendered implementation: `/Users/bytedance/.codex/visualizations/2026/09/03/01a067e9-fe18-72a1-8f71-375e3e94c612/provider-routing-implementation.png`
- Full-view comparison: `/Users/bytedance/.codex/visualizations/2026/09/03/01a067e9-fe18-72a1-8f71-375e3e94c612/provider-routing-comparison.png`
- Focused first-tier comparison: `/Users/bytedance/.codex/visualizations/2026/09/03/01a067e9-fe18-72a1-8f71-375e3e94c612/provider-routing-tier-comparison.png`
- Primary comparison viewport: 1581 x 1324 CSS pixels
- Pixel dimensions: source 1581 x 1324; implementation 1581 x 1324
- Density normalization: both captures compared at 1 CSS pixel to 1 image pixel; no resampling
- State: light theme, zh-Hans, Provider list in read-only mode with three populated tiers

## Findings

- No actionable P0, P1, or P2 visual differences remain.
- Fonts and typography: the implementation uses the product's existing heading and body type system. Hierarchy, weights, line height, wrapping, and small-label treatment match the reference intent.
- Spacing and layout rhythm: tier containers, responsive Provider cards, section gaps, borders, radii, and the centered downward flow marker follow the reference composition. The production cards are slightly taller because all existing card capabilities remain present; this is an intentional product constraint rather than a fidelity defect.
- Colors and visual tokens: the implementation stays on the existing dashboard background, card, border, muted, foreground, primary, and disabled-state tokens.
- Image quality and assets: no raster imagery is required. Provider/plugin marks and all action icons use the product's existing icon sources and Lucide icon family; no placeholder or custom CSS/SVG art was introduced.
- Copy and content: the UI uses the product's i18n messages and consistently names the concepts as tiers and traffic share. Priority and raw weight values are not exposed in this workflow.
- Accessibility: tier and Provider containers remain semantic non-buttons. Only explicit drag handles expose draggable button semantics. Existing links, menus, switches, tooltips, and sliders remain independently operable.
- Responsiveness: checked against the actual tier container width rather than only the viewport. A roughly 1478 px tier renders three columns, 986 px renders two, and 586 px renders one, with no horizontal overflow.

## Interaction Verification

- Mouse drag moved a Provider between tiers and rebalanced both tiers.
- Keyboard drag moved Providers between tiers and reordered tiers.
- Moving the last Provider out removed the empty tier automatically.
- Traffic-share changes kept each tier at exactly 100%; a single-Provider tier exposed a disabled 100% slider.
- Save persisted the route, showed success feedback, and the page reloaded with the saved order and percentages.
- Cancel discarded an unsaved drag.
- Search, enablement filtering, model-list tooltip, edit link, action menu, and Provider switches remained available.
- New and edit Provider pages contain no priority/weight fields or routing section.
- Model routing summaries use tier terminology.
- A fresh browser tab completed the drag/cancel path with no console errors.

## Comparison History

1. Initial comparison found a P2 density mismatch: the implementation expanded to four card columns at the reference viewport, producing narrow cards and excess empty space. The Provider tier grid was initially capped at two columns.
2. Follow-up review found that two columns wasted space on wider screens. The grid now uses container-aware breakpoints: three columns when the tier has room, then two and one as available space narrows.
3. Post-fix browser checks confirmed that card content, drag handles, and existing actions remain usable at each column count. No actionable P0/P1/P2 mismatch remains.

## Follow-up Polish

- P3: the reference uses slightly more compact card heights. The implementation intentionally preserves the existing production Provider card spacing and all of its controls.

final result: passed
