/**
 * Loading-screen tips: controls and mechanics that exist in the game, with the player's own key
 * for each (`{action}` is replaced; a tip whose key is unbound is dropped).
 */

export const TIPS: readonly string[] = [
  'Press {prone} to go prone and lie flat behind low cover.',
  'Press {block} just before a knife strike lands to parry it, then counter hard.',
  'Walk over a radar uplink to take its charge, then press {radar} to see everyone for a moment.',
  'Sprint and crouch together for a low run.',
  'Sprint at low cover to vault it; jump at a ledge to pull yourself up.',
  'Press {grenade} to throw your frag: one per life, and solid cover stops the blast.',
  '{melee} is a quick knife, no weapon switch needed.',
  'Bushes and tall grass hide you from sight.',
  'Press {inspect} to look your weapon over.',
  'Some things in this city are worth finding.',
];

/** Tips with keys filled in by `keyFor` (null = unbound: that tip is left out). */
export function resolveTips(
  keyFor: (action: string) => string | null,
  tips: readonly string[] = TIPS,
): string[] {
  const out: string[] = [];
  for (const t of tips) {
    let ok = true;
    const text = t.replace(/\{(\w+)\}/g, (_, action: string) => {
      const k = keyFor(action);
      if (!k) ok = false;
      return k ?? '';
    });
    if (ok) out.push(text);
  }
  return out;
}

/** The whole list rotated to start at `start` (each tip exactly once per cycle, order kept). */
export function rotateTips<T>(tips: readonly T[], start: number): T[] {
  const n = tips.length;
  if (!n) return [];
  const k = ((Math.floor(start) % n) + n) % n;
  return [...tips.slice(k), ...tips.slice(0, k)];
}
