// Pure gate logic of the headless fresh review (tools/review/fresh-review.mjs). The in-app workflow
// (.claude/workflows/fresh-review.js) carries the same rules inline (workflow scripts can't import);
// tools/review/gate.test.mjs runs both against one scenario table so they can't drift.

export const SEV = { P1: 0, P2: 1, P3: 2 };
export const serious = (f) => SEV[f.severity] <= 1;

/**
 * Merge only findings that are the same issue: same file, lines within 3 (visual findings have no
 * line), titles sharing at least half their words. The most severe copy survives and keeps every
 * lens that raised it. Distinct issues on neighbouring lines stay separate.
 */
export function dedupe(list) {
  const words = (t) => new Set(t.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
  const similar = (a, b) => {
    const x = words(a.title);
    const y = words(b.title);
    const shared = [...x].filter((w) => y.has(w)).length;
    return shared / Math.max(1, Math.min(x.size, y.size)) >= 0.5;
  };
  const out = [];
  for (const f of [...list].sort((a, b) => SEV[a.severity] - SEV[b.severity])) {
    const same = out.find(
      (g) => g.file === f.file && Math.abs((g.line ?? 0) - (f.line ?? 0)) <= 3 && similar(g, f),
    );
    if (same)
      same.alsoFlaggedBy = [...new Set([...same.alsoFlaggedBy, f.lens])].filter(
        (l) => l !== same.lens,
      );
    else out.push({ ...f, alsoFlaggedBy: [] });
  }
  return out;
}

/** Every P1/P2 is verified; `maxVerify` caps only the P3 tail. */
export function splitForVerify(unique, maxVerify) {
  const top = unique.filter(serious);
  const minor = unique.filter((f) => !serious(f));
  const room = Math.max(0, maxVerify - top.length);
  return { toVerify: [...top, ...minor.slice(0, room)], unverified: minor.slice(room) };
}

/** Votes as returned by the skeptics (null / {error} = the skeptic failed). */
export function statusOf(rawVotes) {
  const votes = rawVotes.filter((v) => v && !v.error);
  const failedVotes = rawVotes.length - votes.length;
  const c = votes.filter((v) => v.verdict === 'CONFIRMED').length;
  const r = votes.filter((v) => v.verdict === 'REFUTED').length;
  const status = !votes.length
    ? 'UNVERIFIED'
    : c === votes.length
      ? 'CONFIRMED'
      : r && !c
        ? 'REFUTED'
        : 'PLAUSIBLE';
  return { status, votes, failedVotes };
}

/**
 * Fail closed. BLOCK: a confirmed P1/P2. ERROR: the review is incomplete (a reviewer failed, or a
 * P1/P2's verification lost a skeptic, including "refuted by the only skeptic left"). PASS only
 * when every reviewer ran and every P1/P2 got its full verdict.
 */
export function gateOf({ failedReviews, results }) {
  if (results.some((f) => serious(f) && f.status === 'CONFIRMED')) return 'BLOCK';
  if (failedReviews > 0) return 'ERROR';
  if (results.some((f) => serious(f) && (f.status === 'UNVERIFIED' || f.failedVotes > 0)))
    return 'ERROR';
  return 'PASS';
}
