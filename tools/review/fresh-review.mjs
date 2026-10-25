#!/usr/bin/env node
// Fresh-context review, headless. Every reviewer and skeptic is a separate `claude -p` process with
// no session history (the Codex-exec equivalent), read-only tools, and structured JSON output.
// Same rubric and pipeline as the in-app workflow (.claude/workflows/fresh-review.js).
//
//   node tools/review/fresh-review.mjs                      # staged diff (else working tree)
//   node tools/review/fresh-review.mjs --range abc123..HEAD # a commit range
//   node tools/review/fresh-review.mjs --images e2e/artifacts/*.png   # screenshot QA
//   options: --lenses a,b  --max-verify 12  --jobs 3  --budget 2 (USD per agent)  --model <id>
//
// Report: .review/<label>.md + .json. Exit 1 when a CONFIRMED P1/P2 blocks the commit; exit 2
// (gate ERROR) when the review itself is incomplete: a reviewer or skeptic failed, or a P1/P2 got no
// successful vote. Fails closed: an unreviewed change never reads as PASS.
// Needs the Claude Code CLI signed in (CLAUDE_BIN overrides the binary; default: the desktop app's
// newest bundled claude.exe, else `claude` on PATH).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, globSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dedupe, gateOf, SEV, splitForVerify, statusOf } from './gate.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? dflt : argv[i + 1];
};
const images = (() => {
  const i = argv.indexOf('--images');
  if (i < 0) return null;
  const rest = argv.slice(i + 1);
  const end = rest.findIndex((a) => a.startsWith('--'));
  const given = end < 0 ? rest : rest.slice(0, end);
  // Expand globs ourselves (Windows shells pass them literally); a pattern that matches nothing is
  // an error, not an empty (= passing) screenshot review.
  const found = given.flatMap((p) => (/[*?[]/.test(p) ? globSync(p, { cwd: REPO }) : [p]));
  const missing = found.filter((p) => !existsSync(resolve(REPO, p)));
  if (!found.length || missing.length) {
    console.error(
      `--images: ${found.length ? `missing ${missing.join(', ')}` : `nothing matches ${given.join(' ')}`}`,
    );
    process.exit(2);
  }
  return found;
})();
const RANGE = opt('range', null);
const LENSES = images
  ? ['visual']
  : opt(
      'lenses',
      'correctness,netcode-security,perf-rendering,tests-gates,conventions-assets',
    ).split(',');
const MAX_VERIFY = Number(opt('max-verify', 12));
const JOBS = Number(opt('jobs', 3));
const BUDGET = opt('budget', '2');
const MODEL = opt('model', 'claude-opus-5-5');
const CHUNK_LINES = 2500;
const LABEL = opt('label', images ? 'visual' : RANGE ? RANGE.replace(/[^\w.-]+/g, '_') : 'staged');
const OUT = join(REPO, '.review');
mkdirSync(OUT, { recursive: true });
// A crash (bad --range, git failure, ...) is an incomplete review: exit 2 (ERROR, not 1 = BLOCK)
// and replace any previous report, so a stale PASS/BLOCK is never read as this run's verdict.
const errorReport = (why) => {
  const md = `# Fresh review - ${LABEL}\n\n**Gate: ERROR** (${why})\n`;
  try {
    writeFileSync(join(OUT, `${LABEL}.md`), md);
  } catch {
    /* nothing more to do */
  }
  console.error(md);
  process.exit(2);
};
process.on('uncaughtException', (e) =>
  errorReport(`the review crashed: ${String(e.message).split('\n')[0]}`),
);

function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const root = join(process.env.APPDATA ?? '', 'Claude', 'claude-code');
  if (existsSync(root)) {
    const vers = readdirSync(root)
      .filter((v) => existsSync(join(root, v, 'claude.exe')))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (vers.length) return join(root, vers.at(-1), 'claude.exe');
  }
  return 'claude';
}
const BIN = claudeBin();

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

// Read-only by construction: no Bash (even `git diff --output=…` writes files), only the file
// readers. The diff is handed over as a file under .review/.
const TOOLS = ['Read', 'Grep', 'Glob'];
const ALLOWED = ['Read', 'Grep', 'Glob'];

/** One fresh agent: prompt on stdin, validated JSON back (or null after a retry). */
function runAgent(label, prompt, schema, attempt = 0) {
  return new Promise((done) => {
    const args = [
      '-p',
      '--model',
      MODEL,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      '--tools',
      TOOLS.join(','),
      '--allowedTools',
      ALLOWED.join(' '),
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--max-budget-usd',
      BUDGET,
    ];
    const child = spawn(BIN, args, { cwd: REPO, env: { ...process.env, WD_FRESH_REVIEW: '1' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => done({ error: `spawn ${BIN}: ${e.message}` }));
    child.on('close', async () => {
      let res = null;
      try {
        res = JSON.parse(out);
      } catch {
        /* fall through */
      }
      const value = res?.structured_output;
      if (value && !res.is_error) {
        cost += res.total_cost_usd ?? 0;
        console.log(
          `  ✓ ${label}${res.total_cost_usd ? ` ($${res.total_cost_usd.toFixed(2)})` : ''}`,
        );
        return done(value);
      }
      const why = res?.result ?? err.slice(0, 300) ?? 'no output';
      if (/OAuth|authenticate|login/i.test(why)) return done({ error: `auth: ${why}` });
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 20000 + Math.random() * 10000)); // token refresh races
        return done(await runAgent(label, prompt, schema, attempt + 1));
      }
      console.log(`  ✗ ${label}: ${why}`);
      done(null);
    });
    child.stdin.end(prompt);
  });
}
let cost = 0;

/** Run thunks with at most JOBS at once. */
async function pool(thunks) {
  const out = new Array(thunks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(JOBS, thunks.length) }, async () => {
      while (next < thunks.length) {
        const i = next++;
        out[i] = await thunks[i]();
      }
    }),
  );
  return out;
}

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 << 20 });
const SKIP =
  /(^|\/)(public\/models\/|public\/lightmaps\/.*\.png$)|\.(bin|glb|png|jpg|webp|ogg|hdr)$|pnpm-lock\.yaml$|osm\.gen\.json$/;

// ---- Scope ---------------------------------------------------------------------------------------
let diffFile = '';
let files;
let description = 'screenshot QA';
if (images) {
  files = images.map((p) => ({ path: p, lines: 1 }));
} else {
  let base = RANGE ? [RANGE] : ['--cached'];
  if (!RANGE && !git('diff', '--cached', '--name-only').trim()) base = [];
  // -z: raw paths (no quoting of non-ASCII names); --no-renames: a rename is a delete + add, so
  // both paths are real pathspecs and the new file's hunks are in the diff.
  const stat = git('diff', '--numstat', '-z', '--no-renames', ...base)
    .split('\0')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .map(([ad, rm, p]) => ({ path: p, lines: ad === '-' ? 0 : Number(ad) + Number(rm) }));
  const untracked =
    RANGE || base.length
      ? []
      : git('ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean);
  files = [
    ...stat.map((f) => ({ ...f, lines: SKIP.test(f.path) ? 0 : f.lines })),
    ...untracked.map((p) => ({
      path: p,
      lines: SKIP.test(p) ? 0 : readFileSync(join(REPO, p), 'utf8').split('\n').length,
    })),
  ];
  const paths = files.filter((f) => f.lines > 0).map((f) => f.path);
  const tracked = paths.filter((p) => !untracked.includes(p));
  // Never an empty pathspec: that would diff the whole tree, skipped bulk included.
  let diff = tracked.length ? git('diff', '-U5', '--no-renames', ...base, '--', ...tracked) : '';
  for (const p of untracked.filter((p) => paths.includes(p))) {
    const body = readFileSync(join(REPO, p), 'utf8').split('\n');
    diff += `\ndiff --git a/${p} b/${p}\nnew file (untracked)\n--- /dev/null\n+++ b/${p}\n${body.map((l) => `+${l}`).join('\n')}\n`;
  }
  diffFile = join(OUT, `${LABEL}.diff`);
  writeFileSync(diffFile, diff);
  description = RANGE
    ? `commits ${RANGE}:\n${git('log', '--oneline', RANGE).trim()}`
    : 'the pending (uncommitted) change';
}
const reviewable = files.filter((f) => f.lines > 0);
if (!reviewable.length) {
  console.log('nothing to review');
  process.exit(0);
}
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
console.log(
  `fresh review [${LABEL}] via ${BIN}: ${reviewable.length} files, ${chunks.length} chunk(s) × ${LENSES.length} lens(es)`,
);

// ---- Review --------------------------------------------------------------------------------------
const RO = `You are a read-only reviewer with no prior context. Never edit, stage or commit. Work in ${REPO}.`;
const work = LENSES.flatMap((lens) => chunks.map((files, ci) => ({ lens, files, ci })));
const reviewPrompt = (w) =>
  w.lens === 'visual'
    ? `${RO}\nYou are the VISUAL reviewer. Read tools/review/rubric.md (ground rules + the "visual" lens) and CLAUDE.md (the project's quality bar). Open each screenshot with the Read tool and review it:\n${w.files.join('\n')}\nReport concrete visible defects only (file = image path, line = 0).`
    : `${RO}\nYou are the ${w.lens.toUpperCase()} reviewer for ${description}\nRead tools/review/rubric.md (ground rules + lens "${w.lens}") and the relevant parts of CLAUDE.md. The diff is in ${diffFile}. Your slice: ${w.files.join(', ')} (other files are context). Read the full new versions of your files and what they call, not only the hunks. Report only findings in your lens, each with a concrete failure scenario and file:line. Zero findings is a valid answer.`;

const reviews = await pool(
  work.map((w) => () => runAgent(`review:${w.lens}#${w.ci + 1}`, reviewPrompt(w), FINDINGS)),
);
const authErr = reviews.find((r) => r?.error);
if (authErr) {
  console.error(
    `fresh review could not run: ${authErr.error}\nSign the CLI in once: "${BIN}" (then /login), or set CLAUDE_BIN.`,
  );
  errorReport('the CLI could not sign in');
}
const failedReviews = work
  .filter((_, i) => !reviews[i] || reviews[i].error)
  .map((w) => `${w.lens}#${w.ci + 1}`);
const all = reviews.flatMap((r, i) =>
  (r?.findings ?? []).map((f) => ({ ...f, lens: work[i].lens })),
);
const unique = dedupe(all);
// Every P1/P2 is verified; --max-verify caps only the P3 tail.
const { toVerify, unverified } = splitForVerify(unique, MAX_VERIFY);
console.log(`${all.length} findings → ${unique.length} unique; verifying ${toVerify.length}`);

// ---- Verify --------------------------------------------------------------------------------------
const ANGLES = [
  'Trace the actual call path from the entry point to the claimed line: who calls it, with what values.',
  'Look for existing guards, tests, validation or invariants elsewhere that already prevent it.',
];
const skeptic = (f, angle) =>
  `${RO}\nA reviewer claims a defect. REFUTE it if you can. ${angle}\nRead tools/review/rubric.md ("Verification") first. Diff: ${diffFile || '(screenshot review)'}\n\nClaim (${f.severity}, ${f.lens}): ${f.title}\nWhere: ${f.file}${f.line ? `:${f.line}` : ''}\nDetail: ${f.detail}\nFailure scenario: ${f.failure_scenario}\n\nCONFIRMED only if the scenario really happens; REFUTED if a guard/invariant/caller prevents it (cite it); UNCERTAIN if it needs runtime evidence. Default to REFUTED when evidence is thin. If CONFIRMED, give the minimal fix.`;
const votesFor = await pool(
  toVerify.flatMap((f, fi) =>
    (SEV[f.severity] <= 1 ? ANGLES : ANGLES.slice(0, 1)).map((angle, ai) => async () => ({
      fi,
      v: await runAgent(`verify:${f.file.split('/').pop()}#${ai + 1}`, skeptic(f, angle), VERDICT),
    })),
  ),
);
const verifyAuth = votesFor.find((x) => x.v?.error);
if (verifyAuth) console.error(`skeptic could not run: ${verifyAuth.v.error}`);
const results = toVerify.map((f, fi) => {
  return { ...f, ...statusOf(votesFor.filter((x) => x.fi === fi).map((x) => x.v)) };
});
const confirmed = results.filter((f) => f.status === 'CONFIRMED');
const plausible = results.filter((f) => f.status === 'PLAUSIBLE');
const refuted = results.filter((f) => f.status === 'REFUTED');
const noVerdict = results.filter((f) => f.status === 'UNVERIFIED');
const failedVotes = results.reduce((a, f) => a + f.failedVotes, 0);
// Fail closed (gate.mjs): BLOCK on a confirmed P1/P2; ERROR when the review is incomplete.
const gate = gateOf({ failedReviews: failedReviews.length, results });

// ---- Report --------------------------------------------------------------------------------------
const where = (f) => `\`${f.file}${f.line ? `:${f.line}` : ''}\``;
const fixOf = (f) => f.votes.find((v) => v.fix)?.fix;
const section = (title, list) =>
  list.length
    ? `\n## ${title}\n\n${list
        .map(
          (f) =>
            `- **${f.severity}** ${where(f)} — ${f.title} _(${f.lens})_\n  - Scenario: ${f.failure_scenario}` +
            (fixOf(f) ? `\n  - Fix: ${fixOf(f)}` : ''),
        )
        .join('\n')}\n`
    : '';
const md =
  `# Fresh review — ${LABEL}\n\n**Gate: ${gate}** (${confirmed.length} confirmed, ${plausible.length} plausible, ` +
  `${refuted.length} refuted, ${unverified.length + noVerdict.length} unverified) · ${reviewable.length} files · lenses ${LENSES.join(', ')} · $${cost.toFixed(2)}\n` +
  (failedReviews.length || failedVotes
    ? `\n> **Incomplete review:** ${failedReviews.length} reviewer(s) failed${failedReviews.length ? ` (${failedReviews.join(', ')})` : ''}, ${failedVotes} skeptic run(s) failed. Re-run before trusting this report.\n`
    : '') +
  section('Confirmed', confirmed) +
  section('Plausible (not blocking)', plausible) +
  section('No verdict (every skeptic failed)', noVerdict) +
  section(
    'Unverified (over --max-verify)',
    unverified.map((f) => ({ ...f, votes: [] })),
  ) +
  (refuted.length
    ? `\n## Refuted\n\n${refuted.map((f) => `- ${where(f)} — ${f.title}: ${f.votes.find((v) => v.verdict === 'REFUTED')?.reasoning.split('\n')[0]}`).join('\n')}\n`
    : '');
writeFileSync(join(OUT, `${LABEL}.md`), md);
writeFileSync(
  join(OUT, `${LABEL}.json`),
  JSON.stringify(
    {
      gate,
      confirmed,
      plausible,
      refuted,
      noVerdict,
      unverified,
      failedReviews,
      failedVotes,
      cost,
    },
    null,
    2,
  ),
);
console.log(`\n${md}\nreport → .review/${LABEL}.md`);
process.exit(gate === 'BLOCK' ? 1 : gate === 'ERROR' ? 2 : 0);
