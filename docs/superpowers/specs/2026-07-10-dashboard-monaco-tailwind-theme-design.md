# Dashboard Monaco Tailwind Theme Design

## Goal

Make Monaco feel native to the Dashboard while retaining familiar syntax hierarchy. Use the Prism Vitesse themes as the token-role reference and fixed Tailwind color scales as the implementation palette.

## Theme Model

- Light theme uses `base: "vs"`; dark theme uses `base: "vs-dark"`.
- Both themes use `inherit: false` so Monaco's default blue/purple token and interaction colors cannot leak through.
- Theme colors are resolved through `getCssVariableHex()` or OKLab mixes from `getCssVariableMixHex()`; no hardcoded final hex values are passed to Monaco.
- `emphasis`, `strong`, and `metatag.php` explicitly restore the useful built-in font styles lost when inheritance is disabled.

## Syntax Palette

The palette is intentionally limited:

| Semantic role            | Light                      | Dark                    |
| ------------------------ | -------------------------- | ----------------------- |
| Default text             | neutral-700                | taupe-300               |
| JSON keys                | cyan-400/neutral-500 mix   | cyan-700/taupe-400 mix  |
| Strings                  | red-500/olive-500 mix      | red-400/taupe-400 mix   |
| Numbers                  | sky-700                    | sky-600/slate-400 mix   |
| Keywords and booleans    | green-800                  | teal-600/olive-500 mix  |
| Punctuation and brackets | neutral-500/400 mix        | neutral-500/400 mix     |
| Functions and tags       | lime/green and olive roles | green-500/olive-400 mix |
| Invalid tokens           | red-800                    | red-400                 |

This reproduces Prism Vitesse's JSON relationship: blue-gray keys, muted salmon strings, blue numbers, green booleans and neutral punctuation. The Tailwind variables are mixed only where a single scale value is not close enough.

## Editor UI Colors

Because `inherit: false` also disables built-in UI color inheritance, the theme explicitly defines the supported interactive states:

- cursor, line numbers, current line, selection, word highlights, indentation and whitespace;
- find, hover, links, diagnostics, lightbulbs and overview-ruler markers;
- editor, hover and suggestion widgets, inputs and active options;
- scrollbar and minimap slider states;
- bracket matching and neutral bracket-pair levels;
- sticky scroll, code lens and inlay hints;
- minimap background, opacity, selection, occurrences, find matches and diagnostic markers.

## Verification

- Biome, the TypeScript no-excuse checker, targeted strict TypeScript checking and the Dashboard production build must pass.
- Browser QA covers light mode, dark mode, runtime system-theme switching and a real Monaco text selection.
