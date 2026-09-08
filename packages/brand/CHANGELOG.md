# @aio-proxy/brand

## 0.20.2

No changes in this release.

## 0.20.1

No changes in this release.

## 0.20.0

No changes in this release.

## 0.19.2

### Patch Changes

- [#293](https://github.com/aio-proxy/aio-proxy/pull/293) [`cf45f02`](https://github.com/aio-proxy/aio-proxy/commit/cf45f0222aa85754e64f19dee184228769c97ddd) Thanks [@baranwang](https://github.com/baranwang)! - Render the AIO Proxy wordmark from vector geometry instead of a webfont

  The dashboard logo drew "Proxy" with an SVG `<text>` element styled
  `font-heading font-semibold`. If that webfont had not loaded when the logo
  painted, the word fell back to whatever the system resolved, so the wordmark's
  right half rendered in a different typeface from its left. It is now a single
  path converted from the same letterforms, so the logo looks identical on first
  paint and needs no font loading at all. The wordmark is slightly wider as a
  result (viewBox `0 0 1800 480` to `0 0 1920 480`); it is set in `em` units and
  still scales to its surrounding text.

  The favicon shipped with both surfaces keeps its shape. Its dark-mode ink moves
  from pure white to the theme's off-white (`#fbfbf9`), matching the foreground
  color the rest of the UI already uses; its light-mode ink is unchanged.
