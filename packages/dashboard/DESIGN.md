---
name: aio-proxy Dashboard
description: A quiet, reliable control tower for local model routing.
colors:
  primary: "oklch(51.1% 0.096 186.391)"
  on-primary: "oklch(98.4% 0.014 180.72)"
  background: "oklch(100% 0 0)"
  foreground: "oklch(15.3% 0.006 107.1)"
  card: "oklch(100% 0 0)"
  sidebar: "oklch(98.8% 0.003 106.5)"
  muted: "oklch(96.6% 0.005 106.5)"
  muted-foreground: "oklch(58% 0.031 107.3)"
  border: "oklch(93% 0.007 106.5)"
  input: "oklch(93% 0.007 106.5 / 50%)"
  secondary: "oklch(96.7% 0.001 286.375)"
  on-secondary: "oklch(21% 0.006 285.885)"
  destructive: "oklch(57.7% 0.245 27.325)"
  destructive-soft: "oklch(57.7% 0.245 27.325 / 10%)"
typography:
  headline:
    fontFamily: "Lexend Variable, Lexend, SF Pro Text, PingFang SC, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  title:
    fontFamily: "Lexend Variable, Lexend, SF Pro Text, PingFang SC, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  body:
    fontFamily: "SF Pro TC, SF Pro SC, SF Pro Text, PingFang TC, PingFang SC, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: "normal"
  action:
    fontFamily: "SF Pro TC, SF Pro SC, SF Pro Text, PingFang TC, PingFang SC, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.43
    letterSpacing: "normal"
  label:
    fontFamily: "SF Pro TC, SF Pro SC, SF Pro Text, PingFang TC, PingFang SC, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: "normal"
rounded:
  nav: "0.63rem"
  panel: "0.81rem"
  field: "0.99rem"
  control: "1.17rem"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.75rem"
    height: "2.25rem"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.75rem"
    height: "2.25rem"
  button-destructive:
    backgroundColor: "{colors.destructive-soft}"
    textColor: "{colors.destructive}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.75rem"
    height: "2.25rem"
  input:
    backgroundColor: "{colors.input}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "0.25rem 0.75rem"
    height: "2.25rem"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "1.5rem"
  badge-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.field}"
    padding: "0.125rem 0.5rem"
    height: "1.25rem"
  navigation-active:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.action}"
    rounded: "{rounded.nav}"
    padding: "0.5rem 0.75rem"
    height: "2.25rem"
---

# Design System: aio-proxy Dashboard

## 1. Overview

**Creative North Star: "The Quiet Control Tower"**

This system should feel like working in a quiet control tower: the global state is clear, critical exceptions stand out, and every action produces definite feedback. It uses shadcn `base-luma`'s mature control language to carry complex provider configuration, routing diagnostics, and usage data without letting brand expression obstruct the task.

The visual language must be restrained, reliable, and clear. Familiarity comes from standard Base UI interactions, structure built from the olive scale, and teal that appears only at points of action. Product pages must never reinvent buttons, inputs, overlays, or navigation with one-off styling.

**Key Characteristics:**

- shadcn `base-luma` and Base UI primitives are the only component baseline.
- Olive structure carries hierarchy; signal teal is reserved for primary actions, focus, and critical data.
- Information is dense, but hierarchy stays quiet and state always outranks decoration.
- Light and dark themes share the same semantic roles; product components never hardcode colors.
- Motion explains state changes only; page-load choreography is forbidden.

## 2. Colors

**Olive Structure + Signal Teal.** Olive neutrals establish pages, sidebars, boundaries, and quiet states. Teal is a scarce action signal, never a decorative color.

### Primary

- **Signal Teal** (`colors.primary`): Primary buttons, current selection, focus, and critical states that require action.
- **Signal Teal Foreground** (`colors.on-primary`): Text and icons placed only on signal-teal surfaces.

### Secondary

- **Quiet Secondary Surface** (`colors.secondary`): Secondary buttons and low-emphasis actions that must not compete with the primary action.

### Neutral

- **Clear Canvas** (`colors.background` / `colors.card`): Page and standard content surfaces.
- **Deep Olive Ink** (`colors.foreground`): Body text, headings, and primary icons.
- **Olive Structural Surface** (`colors.sidebar` / `colors.muted`): Sidebars, quiet states, and supporting groups.
- **Olive Supporting Text** (`colors.muted-foreground`): Descriptions, counts, and help text; never critical instructions.
- **Olive Boundary** (`colors.border`): Input boundaries, dividers, and low-contrast structure.
- **Failure Red** (`colors.destructive`): Validation errors and destructive actions, never general emphasis.

**The Signal Rarity Rule.** Teal is reserved for actions, focus, and data encoding. A static page must never show large teal areas for decoration.

**The Semantic Theme Rule.** Components may use only semantic tokens such as `primary`, `muted`, and `border`. Dark mode swaps role values in `src/styles.css`; product code must never name concrete color steps.

## 3. Typography

**Display Font:** Lexend Variable (with Lexend and system sans fallbacks)  
**Body Font:** SF Pro / PingFang / Helvetica / Arial system stack  
**Label/Mono Font:** Labels use the system stack; technical values such as model IDs may use system monospace

**Character:** Lexend gives page and component headings stable, recognizable structure. Body text and controls use system fonts for density, speed, and multilingual readability. The pairing must not create theatrical contrast.

### Hierarchy

- **Headline** (600, 1.25rem, 1.4): The page's single `h1`.
- **Title** (500, 1rem, 1.5): Card, Drawer, Sheet, and local section headings.
- **Body** (400, 0.875rem, 1.43): Forms, tables, and operational guidance; continuous prose is limited to 65–75ch.
- **Action** (500, 0.875rem, 1.43): Buttons, menu items, and interactive labels.
- **Label** (500, 0.75rem, 1.33): Secondary labels and compact status; no all-caps styling or added tracking.

**The Lexend Boundary Rule.** Lexend is for headings only, never buttons, table body text, form labels, or data values.

## 4. Elevation

Elevation follows shadcn `base-luma` exactly. Standard cards use tonal surfaces and a low-contrast 1px keyline without shadows. Page insets may use a shallow structural shadow. Only floating sidebars, Popovers, Drawers, Sheets, and Dialogs receive obvious elevation. Focus uses a translucent 3px ring, never a shadow substitute.

### Shadow Vocabulary

- **Card keyline** (`0 0 0 1px color-mix(in oklch, var(--foreground) 5%, transparent)`): The only static depth on a standard card.
- **Inset low** (`0 1px 3px rgb(0 0 0 / 10%), 0 1px 2px -1px rgb(0 0 0 / 10%)`): Desktop inset content and limited structural layers.
- **Floating shell** (`0 25px 50px -12px rgb(0 0 0 / 10%)`): Floating sidebars and highest-level shells only; forbidden on standard cards.

**The shadcn Elevation Rule.** Use the elevation supplied by shared components. Product pages must not add custom box shadows, glass blur, or arbitrary z-index values.

## 5. Components

Components must come from `src/components/ui`; install missing components through the shadcn CLI. Shared primitives own shape, state, and accessibility. Tailwind is for product layout and composition only.

### Buttons

- **Shape:** Compact soft pill (`rounded.control`), 36px default height, and 12px horizontal padding.
- **Primary:** Signal-teal surface with light teal foreground; keep one primary button per action group.
- **Hover / Focus:** Hover mixes the current semantic background to 80%; focus shows a 3px `ring/30`; active moves down 1px; disabled uses 50% opacity.
- **Secondary / Outline / Ghost:** Respectively use a zinc secondary surface, background with an olive boundary, and no static surface. Never create look-alike variants.
- **Destructive:** Use a 10% failure-red surface with failure-red text instead of a fully saturated red block.

### Chips

- **Style:** Use the shared `Badge`: 20px height, `rounded.field`, and 12px medium text.
- **State:** Communicate state through text and semantic color together; color must never carry meaning alone.

### Cards / Containers

- **Corner Style:** Soft large corners matching primary controls (`rounded.control`).
- **Background:** `card` surface with `card-foreground` text.
- **Shadow Strategy:** A 1px foreground/5 keyline by default; follow the Elevation section.
- **Border:** Use `border` only when a group needs explicit structure; nested cards are forbidden.
- **Internal Padding:** 24px standard, 16px compact.

### Inputs / Fields

- **Style:** 36px height, `rounded.field`, a 50% input tonal surface, and a transparent default border.
- **Focus:** `border-ring` with a 3px `ring/30`; placeholders use `muted-foreground`.
- **Error / Disabled:** `aria-invalid` uses destructive border/ring; disabled prevents interaction and drops to 50% opacity.

### Navigation

- **Style:** The floating sidebar uses an olive structural surface; menu items are 36px high with 12px horizontal padding and `rounded.nav`.
- **States:** Hover, active, and expanded states consistently use `sidebar-accent`; active adds only medium font weight.
- **Responsive:** Desktop collapses to a 48px icon rail; mobile uses the shared Sheet instead of a second navigation system.

### Data Table

- **Style:** Use the shared Table with TanStack Table: 12px cell padding, horizontal dividers, and muted/50 row hover.
- **States:** Sorting, filtering, pagination, and column visibility use shared controls; mobile retains horizontal scrolling instead of becoming a separate card list.
- **Exception:** Server-paginated tables (e.g. request logs) omit client-side sorting, current-page filtering, and column visibility. Their headers are plain labels and ordering/pagination are server-driven, so the loaded page never misrepresents the full result set.

## 6. Do's and Don'ts

### Do:

- **Do** use an existing shadcn component from `src/components/ui` first; add missing components through the shadcn CLI.
- **Do** use semantic color tokens and share the same component code across light and dark themes.
- **Do** keep the default 36px control height, 4px spacing baseline, and shared corner proportions.
- **Do** preserve hover, focus-visible, active, disabled, and error states for every interactive control.
- **Do** make errors and status copy identify the next step while preserving keyboard operation, visible focus, and clear contrast.

### Don't:

- **Don't** create a "flashy SaaS marketing-site style": decorative gradients, glass effects, marketing copy, and task-irrelevant motion are forbidden.
- **Don't** duplicate Button, Input, Badge, Table, Sheet, Dialog, or Sidebar styling in product pages.
- **Don't** use teal to decorate icons, headings, or large backgrounds; it belongs only to actions, focus, and necessary data encoding.
- **Don't** use nested cards, colored side stripes, gradient text, arbitrary box shadows, or `z-index: 9999`.
- **Don't** use color alone to communicate success, failure, enabled, disabled, or selected states.
