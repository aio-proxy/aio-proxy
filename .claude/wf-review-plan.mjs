export const meta = {
  name: 'review-provider-editor-plan',
  description: 'Verify each task of the provider editor implementation plan against real repo source',
  phases: [{ title: 'Review' }],
};

const PLAN = 'docs/superpowers/plans/2026-08-12-provider-editor-redesign.md';
const SPEC = 'docs/superpowers/specs/2026-08-12-provider-editor-redesign-design.md';

const GROUPS = [
  { id: 't1-2', range: '54,213', what: 'validateAliasTargets + aliasEditorIssues empty-models fix' },
  { id: 't3', range: '214,341', what: 'oauth gains a models whitelist end to end' },
  { id: 't4', range: '342,469', what: 'whitelist filters runtime catalog; runtimeIdentity stays stable' },
  { id: 't5-6', range: '470,700', what: 'modelRoutes moves to @aio-proxy/types; ai-sdk draft catalog' },
  { id: 't7', range: '701,952', what: 'oauth drafts can be tested' },
  { id: 't8-10', range: '953,1157', what: 'models-dev slugs endpoint; i18n parity and new keys; ui slider' },
  { id: 't11-13', range: '1158,1522', what: 'lib/section-status, lib/model-rows, use-provider-editor-form' },
  { id: 't14-16', range: '1523,1755', what: 'identity/connection sections, models section, routing section' },
  { id: 't17-20', range: '1756,1963', what: 'advanced+rail, editor shell and oauth two-stage, route swap, changeset' },
];

const SCHEMA = {
  type: 'object',
  required: ['defects', 'verdict'],
  properties: {
    verdict: { type: 'string', enum: ['ready', 'needs-fixes'] },
    defects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'planLine', 'claim', 'evidence', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          planLine: { type: 'number' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
};

const RULES = `
CONTEXT DISCIPLINE — violating this kills your run, which has happened before on this repo:
- Read ONLY your assigned plan line range, with: sed -n '<RANGE>p' ${PLAN}
- Do NOT read the whole plan. It is 1963 lines.
- Do NOT run repo-wide greps (no \`grep -rn <term> packages/\` without a narrow path). Every grep must name a specific file or a single directory.
- Never cat a file over ~400 lines. Use \`sed -n 'A,Bp' file\` around the line numbers the plan cites.
- Budget about 20 tool calls. Stop and report if you approach it.
- You may read ${SPEC} in full (320 lines) — it is the contract the plan implements.

YOUR JOB
Check the plan's assigned tasks against the ACTUAL source in this worktree. You are looking for things that would make an implementer produce broken or wrong code. Specifically:

1. FALSE CLAIMS: the plan cites a file, line, symbol, type, enum member, function signature, schema field, or export that does not exist or does not say what the plan says. Verify every cited path:line you can cheaply.
2. NON-COMPILING STEPS: a step whose diff would not typecheck — wrong type name, missing import, a field not in the Zod schema, a function called with the wrong arity, a strictObject given an unknown key, a discriminated union missing a branch.
3. CONTRADICTS THE SPEC: the plan does something the spec explicitly forbids or requires otherwise. The spec is authoritative. Two deviations are already declared in the plan's Self-Review Notes section (ai-sdk baseURL already carries /v1; oauth narrowed at the testProviderDraft entry) — judge whether each declared deviation is actually CORRECT, and say so; do not report a declared-and-correct deviation as a defect.
4. INTERNAL INCONSISTENCY: a symbol, signature, filename, or i18n key this task defines or consumes that disagrees with how the plan uses it elsewhere in YOUR range.
5. MISSING WORK that the task claims to complete: e.g. a schema field added in one place but not the sibling place that also needs it, a test asserted on behavior the step does not implement, a deleted file still imported.
6. REPO RULE VIOLATIONS: 500-line file cap; colocated same-name-directory tests; one React component per .tsx; no hardcoded user-facing strings; TanStack Form for inputs; no direct fetch in components; es-toolkit before hand-rolled utilities; changesets must target a product package (aio-proxy) not only internal ones.

RULES OF EVIDENCE
- Report a defect ONLY after you have seen the contradicting source with your own eyes. Put the file:line and the actual text in \`evidence\`.
- If you suspect something but could not confirm it within budget, do not report it.
- Do not report style preferences, wording, or "could be cleaner". Only things that break.
- Do not report the absence of something the spec lists as a Non-Goal.
- \`planLine\` is the absolute line number in the plan file where the problem lives.
- severity: blocker = implementer produces broken/wrong code or the task cannot be done as written; major = real defect, wastes a cycle or ships a bug; minor = a wrong citation that misleads but is locally obvious.

Return verdict 'ready' with an empty defects array if your range is genuinely sound.
`;

const results = await parallel(
  GROUPS.map(
    (g) => () =>
      agent(
        `You are reviewing part of an implementation plan in the worktree /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/provider-07e326 (cd there first; all paths are relative to it).

Your assigned range is plan lines ${g.range}, covering: ${g.what}

Read it with: sed -n '${g.range}p' ${PLAN}
${RULES}`,
        { label: `review:${g.id}`, phase: 'Review', schema: SCHEMA },
      ).then((r) => ({ group: g.id, what: g.what, ...(r ?? { verdict: 'error', defects: [] }) })),
  ),
);

const all = results.filter(Boolean);
const blockers = all.flatMap((r) =>
  (r.defects ?? []).filter((d) => d.severity === 'blocker').map((d) => ({ group: r.group, ...d })),
);
log(`${all.length} groups reviewed, ${blockers.length} blockers`);
return { groups: all, blockerCount: blockers.length };
