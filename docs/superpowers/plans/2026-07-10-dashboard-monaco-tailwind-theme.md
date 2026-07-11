# Dashboard Monaco Tailwind Theme Implementation Plan

**Goal:** Replace Monaco's inherited syntax and interaction colors with a Prism Vitesse-inspired fixed Tailwind palette that matches the Dashboard.

## Completed Tasks

- [x] Keep `base: "vs"` and `base: "vs-dark"` while setting `inherit: false`.
- [x] Map Monaco token groups to the Prism Vitesse JSON relationships using fixed Tailwind scales.
- [x] Separate JSON keys, strings, numbers, booleans and punctuation into blue-gray, salmon, blue, green and neutral roles.
- [x] Use OKLab Tailwind-variable mixes where one fixed scale is not close enough to the reference.
- [x] Restore emphasis, strong and PHP metatag font styles explicitly.
- [x] Extract shared editor UI color generation to `theme-colors.ts`.
- [x] Define core selection, find, hover, diagnostic, widget, input, scrollbar and overview-ruler colors.
- [x] Define minimap background, opacity, selection, occurrence, find, diagnostic and slider colors.
- [x] Resolve every explicit Monaco color through `getCssVariableHex()` or `getCssVariableMixHex()`.
- [x] Run Biome, strict rules, targeted TypeScript checking and the Dashboard production build.
- [x] Verify light mode, dark mode, runtime switching and text selection in a real browser.
- [x] Complete independent integrity and visual QA reviews with no blocking findings.

## Constraints Preserved

- Monaco loading, language setup, editor props and public component API remain unchanged.
- The existing editor background treatment and default-disabled minimap behavior remain unchanged.
- No commits are created because the worktree contains unrelated user changes.
