# aio-proxy Dashboard Design System

## 1. Atmosphere & Identity

The dashboard is a quiet operational console: compact enough for configuration work, but never visually crowded. Its signature is olive-toned structure with teal actions, Lexend headings, and layered Base UI surfaces that keep complex routing configuration readable without decorative effects.

## 2. Color

### Palette

All colors come from `src/styles.css`; components use semantic Tailwind tokens rather than raw color values.

| Role | Token | Usage |
|---|---|---|
| Page surface | `background` | App and page backgrounds |
| Primary text | `foreground` | Body text and headings |
| Card surface | `card` | Cards and grouped configuration |
| Elevated surface | `popover` | Drawers, sheets, selects, dialogs, and menus |
| Primary action | `primary` | Save and affirmative actions |
| Secondary action | `secondary` | Quiet actions and close controls |
| Muted surface | `muted` | Supporting panels and empty states |
| Muted text | `muted-foreground` | Descriptions, counts, and helper text |
| Border/input | `border`, `input` | Dividers and form control outlines |
| Focus | `ring` | Keyboard focus indication |
| Destructive | `destructive` | Validation and destructive actions |
| Overlay | `overlay` | Drawer, sheet, and dialog backdrops |

Light mode uses olive neutrals with teal actions. Dark mode preserves the same roles using the dark token values already declared in `src/styles.css`.

### Rules

- Use semantic tokens only; add a token to `src/styles.css` before introducing a new color role.
- Teal is reserved for actions and focus, not decoration.
- Error meaning uses `destructive`; supporting information uses `muted-foreground`.

## 3. Typography

### Font Stack

- Headings: `--font-heading`, Lexend Variable with the existing fallback chain.
- Body: `--font-sans`, the existing SF Pro/PingFang/Helvetica/Arial system stack.
- Monospace: browser/system monospace only where model IDs need code-like treatment.

### Scale

| Level | Utility | Usage |
|---|---|---|
| Page heading | existing `PageContainer` heading style | Route titles |
| Component heading | `font-heading text-base font-medium` | Drawer, sheet, and card titles |
| Body | `text-sm` or inherited body size | Form controls and operational content |
| Supporting | `text-sm text-muted-foreground` | Descriptions, counts, and hints |

Body and interactive text stays at least 14px. Model IDs may use tabular or monospace presentation when alignment benefits.

## 4. Spacing & Layout

### Base Unit

Spacing follows Tailwind's 4px scale. Existing dashboard composition primarily uses `gap-2`, `gap-3`, `gap-4`, `p-3`, `p-4`, and `p-6`.

### Grid and Responsive Rules

- Provider forms retain their current `max-w-lg` page column.
- Configuration rows stack on narrow screens and use grid columns at `md` when fields benefit from comparison.
- Provider aliases use the Base UI Drawer from the bottom below 768px and from the right at 768px and above.
- The desktop Provider alias Drawer is full height and no wider than 680px; mobile uses the built-in bottom Drawer height constraints.
- Drawer headers and footers remain fixed while the content region scrolls.

## 5. Components

### Form Field

- **Structure**: shadcn `Field` + `Label` + an existing control.
- **States**: default, focus, disabled, and `data-invalid`/`aria-invalid` error.
- **Accessibility**: every control has a visible label or translated ARIA label.

### Configuration Card

- **Structure**: semantic section with heading, supporting description, fields, and actions.
- **Surface**: `card` or `background` with `border`; inner controls use tighter radius than the outer group.
- **Spacing**: `gap-3` and `p-4` by default.
- **States**: default, focused-within, and error using semantic tokens.


### Empty State

- Use the existing shadcn `Empty` composition for a truly empty collection.
- Keep copy direct and operational; one primary next action is sufficient.

## 6. Motion & Interaction

- Reuse the existing Base UI Drawer, Sheet, and dialog transitions.
- Micro interactions use the existing component transitions; do not add decorative animation.
- Animate only `transform` and `opacity`.
- Preserve visible hover, active, and focus feedback from shared components.
- Respect reduced-motion behavior provided by the primitives and global styles.

## 7. Depth & Surface

The dashboard uses a mixed border-and-shadow strategy already present in shared components:

- Page and configuration grouping primarily use semantic borders and tonal surface changes.
- Drawers, sheets, and dialogs use the shared elevated popover surface and existing shadow.
- Inner cards use a tighter radius than the containing Drawer, Sheet, or section.
- Do not introduce one-off shadows, raw colors, or decorative gradients.
