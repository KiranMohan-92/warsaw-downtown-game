/**
 * How one shot ended, judged from sets of bodies. A fan (shotgun) strikes several bodies under
 * one input seq, and the server answers with one event per body, in any order: every per-shot
 * fact is therefore a set, never "the" target, and the verdict is a pure function of the four.
 */

/** The four facts about a shot, as sorted id lists without duplicates (`sortedIds`). */
export interface ShotSets {
  /** Bodies the shooter's own trace struck, drawn unprotected (the hit marker)… */
  hits: readonly string[];
  /** …and the ones it struck drawn spawn-protected (their shimmer: the blocked marker). */
  shielded: readonly string[];
  /** Bodies the server reported this shot damaged… */
  damaged: readonly string[];
  /** …and the ones it reported the shot blocked on (`outcome: 'protected'`, no damage). */
  blocked: readonly string[];
}

/** Every body a shot touched on either side, in exactly one of four classes. */
export interface ShotVerdict {
  /** Damage on a body the shooter hit: the confirm. */
  confirmed: string[];
  /** A predicted hit the server neither damaged nor blocked: the unfair miss. */
  unconfirmed: string[];
  /** Damage on a body the shooter's trace never struck: a false (or bystander) hit. */
  falseHits: string[];
  /**
   * Outcomes spawn protection explains, a difference of its timing and not of the aim: a body
   * drawn protected (blocked, damaged once its protection had ended, or untouched), a predicted
   * hit the server blocked (the shimmer was not drawn yet), a block on a body not struck locally.
   */
  exempt: string[];
  /** Nothing but exempt outcomes: the shot is "blocked", neither a hit nor a miss. */
  protectedOnly: boolean;
}

/** A set of ids as the record keeps it: sorted, no duplicates (so records compare equal). */
export function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/**
 * The bodies a local trace struck (one entry per pellet, any order), split by how they were
 * drawn. As `Game.fireShot`: a shimmering body shows the blocked marker, anyone else the hit.
 */
export function splitStruck(
  struck: Iterable<string>,
  drawnProtected: ReadonlySet<string>,
): Pick<ShotSets, 'hits' | 'shielded'> {
  const ids = sortedIds(struck);
  return {
    hits: ids.filter((id) => !drawnProtected.has(id)),
    shielded: ids.filter((id) => drawnProtected.has(id)),
  };
}

/** The server's answers for one shot, gathered as they arrive (order never matters). */
export interface ShotOutcomes {
  damaged: Set<string>;
  blocked: Set<string>;
}

export function noteOutcome(into: ShotOutcomes, target: string, outcome: string | undefined): void {
  (outcome === 'protected' ? into.blocked : into.damaged).add(target);
}

export function shotVerdict(s: ShotSets): ShotVerdict {
  const hits = new Set(s.hits);
  const shielded = new Set(s.shielded);
  const damaged = new Set(s.damaged);
  const blocked = new Set(s.blocked);
  const confirmed = sortedIds(s.hits.filter((id) => damaged.has(id)));
  const unconfirmed = sortedIds(s.hits.filter((id) => !damaged.has(id) && !blocked.has(id)));
  const falseHits = sortedIds(s.damaged.filter((id) => !hits.has(id) && !shielded.has(id)));
  const exempt = sortedIds([
    ...s.shielded.filter((id) => !hits.has(id)),
    ...s.blocked.filter((id) => !damaged.has(id)),
  ]);
  return {
    confirmed,
    unconfirmed,
    falseHits,
    exempt,
    protectedOnly:
      exempt.length > 0 && !confirmed.length && !unconfirmed.length && !falseHits.length,
  };
}

/** What became of one body under a shot (null: neither side touched it). */
export type BodyOutcome = 'confirmed' | 'unconfirmed' | 'false hit' | 'exempt' | null;

export function bodyOutcome(v: ShotVerdict, id: string): BodyOutcome {
  if (v.confirmed.includes(id)) return 'confirmed';
  if (v.unconfirmed.includes(id)) return 'unconfirmed';
  if (v.falseHits.includes(id)) return 'false hit';
  return v.exempt.includes(id) ? 'exempt' : null;
}
