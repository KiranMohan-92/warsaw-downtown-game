export const meta = {
  name: 'fresh-review',
  description:
    'Fresh-context code review (Codex-review replacement): lens reviewers on the diff, adversarial verification, gate verdict',
  whenToUse:
    'Before every commit (called by /commit), or over a commit range, e.g. args {range: "abc123..HEAD"}. Screenshot QA: args {images: ["e2e/artifacts/x.png"]}.',
  phases: [
    { title: 'Scope', detail: 'collect the diff and changed files' },
    { title: 'Review', detail: 'one fresh reviewer per lens and chunk' },
    { title: 'Verify', detail: 'fresh skeptics try to refute each finding' },
    { title: 'Report', detail: 'write .review/<label>.md' },
  ],
};

// Every agent here starts with no conversation context: it sees only what the prompt names (the
// diff file, the repo, CLAUDE.md, tools/review/rubric.md). That independence is the point: the
// reviewer cannot inherit the author's assumptions.
const a = args ?? {};
const REPO = a.repo ?? 'C:/Users/kiran/myprojects/warsaw-downtown';
const LABEL =
  a.label ?? (a.images ? 'visual' : a.range ? a.range.replace(/[^\w.-]+/g, '_') : 'staged');
const MAX_VERIFY = a.maxVerify ?? 12;
const CHUNK_LINES = a.chunkLines ?? 2500;
const LENSES = a.images
  ? ['visual']
  : (a.lenses ?? [
      'correctness',
      'netcode-security',
      'perf-rendering',
      'tests-gates',
      'conventions-assets',
    ]);
const SEV = { P1: 0, P2: 1, P3: 2 };

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['P1', 'P2', 'P3'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
          detail: { type: 'string' },
          failure_scenario: { type: 'string' },
        },
        required: ['severity', 'file', 'title', 'detail', 'failure_scenario'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['findings'],
};
const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'UNCERTAIN'] },
    reasoning: { type: 'string' },
    fix: { type: 'string' },
  },
  required: ['verdict', 'reasoning'],
};
const SCOPE = {
  type: 'object',
  properties: {
    diffFile: { type: 'string' },
    description: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, lines: { type: 'integer' } },
        required: ['path', 'lines'],
      },
    },
  },
  required: ['diffFile', 'files', 'description'],
};

const READ_ONLY = `You are a read-only reviewer: never edit, stage, commit, install or start servers. Read-only git/rg/Read only (one targeted \`pnpm vitest run <file>\` is allowed to prove a point). Work in ${REPO}.`;

// ---- Scope ---------------------------------------------------------------------------------------
phase('Scope');
let scope;
if (a.images) {
  scope = {
    diffFile: '',
    description: 'screenshot QA',
    files: a.images.map((p) => ({ path: p, lines: 1 })),
  };
} else {
  const what = a.range
    ? `the commit range ${a.range} (\`git diff ${a.range}\`, plus \`git log --oneline ${a.range}\` for intent)`
    : 'the pending change: the staged diff (`git diff --cached`); if nothing is staged, the unstaged diff (`git diff`) plus untracked files that are not git-ignored (`git ls-files --others --exclude-standard`; include their full contents as additions)';
  scope = await agent(
    `${READ_ONLY}\nCollect ${what} in ${REPO}. Write the complete unified diff (with 5 lines of context: \`-U5\`) to ${REPO}/.review/${LABEL}.diff (create .review/ if needed; that is the only file you may write). Exclude binary files and generated bulk data (public/models/**, public/lightmaps/*.png, *.bin, *.glb, pnpm-lock.yaml, osm.gen.json) from the diff but still list them in files with lines=0. Return the diff file path, each changed path with its changed-line count, and a two-sentence description of what the change is trying to do (from commit messages / code).`,
    { label: 'scope', phase: 'Scope', schema: SCOPE, effort: 'low' },
  );
}
// Fail closed: a failed Scope agent is an incomplete review, not an empty change.
if (!scope) return { gate: 'error', note: 'scope agent failed: nothing was reviewed' };
if (!scope.files.length) return { gate: 'pass', note: 'nothing to review' };

// Chunk the reviewable files so each reviewer's slice fits comfortably.
const reviewable = scope.files.filter((f) => f.lines > 0);
const chunks = [];
let cur = [];
let n = 0;
for (const f of reviewable) {
  if (cur.length && n + f.lines > CHUNK_LINES) {
    chunks.push(cur);
    cur = [];
    n = 0;
  }
  cur.push(f.path);
  n += f.lines;
}
if (cur.length) chunks.push(cur);
log(`${reviewable.length} files in ${chunks.length} chunk(s) × ${LENSES.length} lens(es)`);

// ---- Review → dedup → verify ---------------------------------------------------------------------
const work = [];
for (const lens of LENSES) chunks.forEach((files, ci) => work.push({ lens, files, ci }));

const reviewPrompt = (w) =>
  w.lens === 'visual'
    ? `${READ_ONLY}\nYou are the VISUAL reviewer. Read ${REPO}/tools/review/rubric.md (ground rules + the "visual" lens) and ${REPO}/CLAUDE.md (project bar). Then open each screenshot with the Read tool and review it:\n${w.files.join('\n')}\nReport only concrete visible defects (file = the image path, line = 0).`
    : `${READ_ONLY}\nYou are the ${w.lens.toUpperCase()} reviewer for this change: ${scope.description}\nRead ${REPO}/tools/review/rubric.md (ground rules + your lens "${w.lens}") and the relevant parts of ${REPO}/CLAUDE.md. The diff is in ${scope.diffFile}. Your slice: ${w.files.join(', ')} (other files in the diff are context only). Read the full new versions of your files and whatever they call, not just the hunks. Report only findings in your lens, each with a concrete failure scenario and file:line. Zero findings is a valid answer.`;

const reviews = await parallel(
  work.map(
    (w) => () =>
      agent(reviewPrompt(w), {
        label: `review:${w.lens}#${w.ci + 1}`,
        phase: 'Review',
        schema: FINDINGS,
      }).then((r) => (r ? (r.findings ?? []).map((f) => ({ ...f, lens: w.lens })) : null)),
  ),
);
// Barrier on purpose: dedup across all lenses before paying for verification.
// A null review is a failed reviewer: the gate fails closed (error), never silently "no findings".
const failedReviews = work.filter((_, i) => !reviews[i]).map((w) => `${w.lens}#${w.ci + 1}`);
if (failedReviews.length)
  log(`${failedReviews.length} reviewer(s) failed: ${failedReviews.join(', ')} (gate: error)`);
const all = reviews.filter(Boolean).flat();
// Merge only the same issue: same file, lines within 3, titles sharing half their words. The most
// severe copy survives and keeps every lens that raised it.
const words = (t) => new Set(t.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
const similar = (x, y) => {
  const wx = words(x.title);
  const wy = words(y.title);
  const shared = [...wx].filter((w) => wy.has(w)).length;
  return shared / Math.max(1, Math.min(wx.size, wy.size)) >= 0.5;
};
const unique = [];
for (const f of [...all].sort((x, y) => SEV[x.severity] - SEV[y.severity])) {
  const same = unique.find(
    (g) => g.file === f.file && Math.abs((g.line ?? 0) - (f.line ?? 0)) <= 3 && similar(g, f),
  );
  if (same)
    same.alsoFlaggedBy = [...new Set([...same.alsoFlaggedBy, f.lens])].filter(
      (l) => l !== same.lens,
    );
  else unique.push({ ...f, alsoFlaggedBy: [] });
}
// Every P1/P2 is verified; MAX_VERIFY caps only the P3 tail.
const serious = unique.filter((f) => SEV[f.severity] <= 1);
const minor = unique.filter((f) => SEV[f.severity] > 1);
const room = Math.max(0, MAX_VERIFY - serious.length);
const toVerify = [...serious, ...minor.slice(0, room)];
const unverified = minor.slice(room);
if (unverified.length) log(`${unverified.length} lower-ranked P3 finding(s) reported unverified`);

const skeptic = (f, angle) =>
  `${READ_ONLY}\nA reviewer claims a defect in ${REPO}. Your job is to REFUTE it if you can. ${angle}\nRead ${REPO}/tools/review/rubric.md ("Verification") first. Diff: ${scope.diffFile || '(screenshot review)'}\n\nClaim (${f.severity}, ${f.lens}): ${f.title}\nWhere: ${f.file}${f.line ? `:${f.line}` : ''}\nDetail: ${f.detail}\nFailure scenario: ${f.failure_scenario}\n\nVerdict CONFIRMED only if the scenario really happens in this code; REFUTED if a guard, invariant or caller makes it impossible (cite it); UNCERTAIN if it needs runtime evidence. Default to REFUTED when evidence is thin. If CONFIRMED, give the minimal fix.`;
const ANGLES = [
  'Trace the actual call path from the entry point to the claimed line: who calls it, with what values.',
  'Look for existing guards, tests, validation or invariants elsewhere that already prevent it; run one targeted vitest if that settles it.',
];

const judged = await parallel(
  toVerify.map((f) => async () => {
    const angles = SEV[f.severity] <= 1 ? ANGLES : ANGLES.slice(0, 1);
    const votes = (
      await parallel(
        angles.map(
          (angle, i) => () =>
            agent(skeptic(f, angle), {
              label: `verify:${f.file.split('/').pop()}#${i + 1}`,
              phase: 'Verify',
              schema: VERDICT,
            }),
        ),
      )
    ).filter(Boolean);
    const confirmed = votes.filter((v) => v.verdict === 'CONFIRMED').length;
    const refuted = votes.filter((v) => v.verdict === 'REFUTED').length;
    const status = !votes.length
      ? 'UNVERIFIED'
      : confirmed === votes.length
        ? 'CONFIRMED'
        : refuted > 0 && confirmed === 0
          ? 'REFUTED'
          : 'PLAUSIBLE';
    return { ...f, status, votes, failedVotes: angles.length - votes.length };
  }),
);
const results = judged.filter(Boolean);
const confirmed = results.filter((f) => f.status === 'CONFIRMED');
const plausible = results.filter((f) => f.status === 'PLAUSIBLE');
const refuted = results.filter((f) => f.status === 'REFUTED');
const noVerdict = results.filter((f) => f.status === 'UNVERIFIED');
const failedVotes = results.reduce((sum, f) => sum + f.failedVotes, 0);
// Fail closed: block on a confirmed P1/P2; error when the review is incomplete (a reviewer failed,
// a finding's verification died, or a P1/P2 got no verdict); pass only when everything ran.
// Same rules as tools/review/gate.mjs gateOf (gate.test.mjs runs both on one scenario table).
const gate = confirmed.some((f) => SEV[f.severity] <= 1)
  ? 'block'
  : failedReviews.length ||
      judged.some((j) => !j) ||
      results.some((f) => SEV[f.severity] <= 1 && (f.status === 'UNVERIFIED' || f.failedVotes > 0))
    ? 'error'
    : 'pass';

// ---- Report --------------------------------------------------------------------------------------
phase('Report');
const summary = {
  gate,
  label: LABEL,
  scope: scope.description,
  files: scope.files.length,
  chunks: chunks.length,
  lenses: LENSES,
  confirmed,
  plausible,
  noVerdict,
  failedReviews,
  failedVotes,
  refuted: refuted.map((f) => ({
    severity: f.severity,
    file: f.file,
    line: f.line,
    title: f.title,
    why: f.votes.map((v) => v.reasoning),
  })),
  unverified,
};
await agent(
  `Write ${REPO}/.review/${LABEL}.md (overwrite; the only file you may write) as a concise markdown review report from this JSON. Order: gate verdict line (the JSON's gate in capitals: BLOCK / ERROR / PASS; for ERROR say the review is incomplete and list failedReviews / failedVotes), then CONFIRMED findings (severity, file:line, title, failure scenario, fix), PLAUSIBLE ones, noVerdict ones (every skeptic failed), UNVERIFIED ones, then a short "Refuted" list with the one-line reason. No preamble.\n\n${JSON.stringify(summary)}`,
  { label: 'report', phase: 'Report', effort: 'low' },
);
return summary;
