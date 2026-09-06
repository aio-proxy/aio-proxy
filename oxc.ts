export const ignorePatterns = [
  '**/dist/**',
  '.reference/**',
  '.worktrees/**',
  // Generated logo geometry; oxfmt would wrap its multi-kilobyte single-line path constants.
  'packages/brand/src/logo-geometry.ts',
  'packages/core/src/db/migrations.manifest.ts',
  'packages/dashboard/src/route-tree.gen.ts',
  'packages/i18n/project.inlang/**',
  'packages/i18n/src/paraglide/**',
  'packages/plugins/cursor/src/gen/**',
  // shadcn-generated primitives are maintained upstream rather than by this repository.
  'packages/ui/src/components/**',
  'docs/superpowers/**',
  // Verbatim upstream codex instructions snapshot imported as text; must not be reformatted.
  'packages/server/src/server/list-models/codex-client-models/default-instructions.md',
];
