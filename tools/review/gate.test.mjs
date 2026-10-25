// The fail-closed gate, tested twice over one scenario table: the headless runner's pure logic
// (gate.mjs) and the in-app workflow script itself (.claude/workflows/fresh-review.js), executed
// with a fake workflow runtime whose "agents" die, confirm or refute on cue.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dedupe, gateOf, splitForVerify, statusOf } from './gate.mjs';

const WORKFLOW = readFileSync(
  new URL('../../.claude/workflows/fresh-review.js', import.meta.url),
  'utf8',
);

const P2 = {
  severity: 'P2',
  file: 'a.ts',
  line: 10,
  title: 'shots skip lag compensation',
  detail: 'd',
  failure_scenario: 's',
};
const P3 = {
  severity: 'P3',
  file: 'b.ts',
  line: 3,
  title: 'stale comment',
  detail: 'd',
  failure_scenario: 's',
};
const yes = { verdict: 'CONFIRMED', reasoning: 'r' };
const no = { verdict: 'REFUTED', reasoning: 'r' };

/**
 * Scenarios: reviews[lens] = findings array, or null (reviewer died); votes = per-skeptic verdicts
 * for every verified finding, null = that skeptic died. `gate` is the expected verdict.
 */
const SCENARIOS = [
  { name: 'clean change', reviews: {}, votes: [], gate: 'PASS' },
  { name: 'a reviewer died', reviews: { 'tests-gates': null }, votes: [], gate: 'ERROR' },
  { name: 'confirmed P2', reviews: { correctness: [P2] }, votes: [yes, yes], gate: 'BLOCK' },
  { name: 'refuted P2', reviews: { correctness: [P2] }, votes: [no, no], gate: 'PASS' },
  {
    name: 'P2 with every skeptic dead',
    reviews: { correctness: [P2] },
    votes: [null, null],
    gate: 'ERROR',
  },
  {
    name: 'P2 refuted by the only surviving skeptic',
    reviews: { correctness: [P2] },
    votes: [null, no],
    gate: 'ERROR',
  },
  {
    name: 'split vote on P2 (plausible)',
    reviews: { correctness: [P2] },
    votes: [yes, no],
    gate: 'PASS',
  },
  {
    name: 'confirmed P3 does not block',
    reviews: { correctness: [P3] },
    votes: [yes],
    gate: 'PASS',
  },
  {
    name: 'P3 whose skeptic died does not error',
    reviews: { correctness: [P3] },
    votes: [null],
    gate: 'PASS',
  },
  {
    name: 'dead reviewer beside a confirmed P2 still blocks',
    reviews: { correctness: [P2], 'tests-gates': null },
    votes: [yes, yes],
    gate: 'BLOCK',
  },
];

/** The runner's gate over a scenario, through gate.mjs. */
function runnerGate(sc) {
  const lenses = [
    'correctness',
    'netcode-security',
    'perf-rendering',
    'tests-gates',
    'conventions-assets',
  ];
  const failedReviews = lenses.filter((l) => sc.reviews[l] === null).length;
  const all = lenses.flatMap((l) => (sc.reviews[l] ?? []).map((f) => ({ ...f, lens: l })));
  const { toVerify } = splitForVerify(dedupe(all), 12);
  const results = toVerify.map((f) => {
    const n = f.severity === 'P3' ? 1 : 2;
    return { ...f, ...statusOf(sc.votes.slice(0, n)) };
  });
  return gateOf({ failedReviews, results });
}

/** Run the real workflow script with a fake runtime; returns its summary. */
async function workflowRun(sc, { scope = true } = {}) {
  const src = WORKFLOW.replace(/^export const meta\s*=/m, 'const meta =');
  const run = new Function(
    'args',
    'agent',
    'parallel',
    'pipeline',
    'phase',
    'log',
    'budget',
    `return (async () => {\n${src}\n})();`,
  );
  const agent = async (prompt, opts = {}) => {
    const label = opts.label ?? '';
    if (label === 'scope')
      return scope
        ? {
            diffFile: '/tmp/x.diff',
            description: 'test',
            files: [
              { path: 'a.ts', lines: 20 },
              { path: 'b.ts', lines: 5 },
            ],
          }
        : null;
    if (label.startsWith('review:')) {
      const lens = label.slice(7).split('#')[0];
      if (!(lens in sc.reviews)) return { findings: [] };
      return sc.reviews[lens] === null ? null : { findings: sc.reviews[lens] };
    }
    if (label.startsWith('verify:')) return sc.votes[Number(label.split('#')[1]) - 1] ?? null;
    return 'ok'; // report writer
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  return run(
    { repo: '/repo' },
    agent,
    parallel,
    null,
    () => {},
    () => {},
    { total: null },
  );
}

describe('fresh-review gate (fail closed)', () => {
  it.each(SCENARIOS)('runner: $name → $gate', (sc) => {
    expect(runnerGate(sc)).toBe(sc.gate);
  });

  it.each(SCENARIOS)('workflow: $name → $gate', async (sc) => {
    expect((await workflowRun(sc)).gate.toUpperCase()).toBe(sc.gate);
  });

  it('workflow: a failed Scope agent is an error, not an empty pass', async () => {
    expect((await workflowRun(SCENARIOS[0], { scope: false })).gate).toBe('error');
  });

  it('dedupe keeps distinct issues on neighbouring lines, merges the same issue across lenses', () => {
    const other = { ...P2, line: 12, title: 'health never resets on respawn' };
    expect(dedupe([P2, other].map((f) => ({ ...f, lens: 'correctness' })))).toHaveLength(2);
    const same = dedupe([
      { ...P2, lens: 'correctness' },
      {
        ...P2,
        line: 11,
        severity: 'P3',
        title: 'Shots skip lag compensation here',
        lens: 'netcode-security',
      },
    ]);
    expect(same).toHaveLength(1);
    expect(same[0].severity).toBe('P2');
    expect(same[0].alsoFlaggedBy).toEqual(['netcode-security']);
  });

  it('every P1/P2 is verified; the cap only trims P3s', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...P2,
      line: i * 10,
      title: `bug ${i} ${'x'.repeat(i)}`,
    }));
    const { toVerify, unverified } = splitForVerify([...many, P3], 2);
    expect(toVerify).toHaveLength(5);
    expect(unverified).toEqual([P3]);
  });
});
