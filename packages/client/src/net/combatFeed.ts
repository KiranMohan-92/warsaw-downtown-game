import { UNLIMITED, type CombatEvent, type CombatWeapon, type MatchStateMessage } from '@wd/shared';

/** The texts the HUD shows for an online match (pure, so the wording is tested). */

type NameOf = (id: string) => string;

const WEAPON: Record<CombatWeapon, string> = {
  rifle: 'rifle',
  sidearm: 'pistol',
  knife: 'knife',
  frag: 'frag',
  truck: 'run over',
  wreck: 'truck explosion',
};

/** One kill-feed line for a killing blow, from this player's point of view. */
export function killLine(
  e: Extract<CombatEvent, { type: 'hit' }>,
  me: string,
  nameOf: NameOf,
): string {
  const who = (id: string): string => (id === me ? 'You' : nameOf(id));
  const blast = e.weapon === 'frag' || e.weapon === 'truck' || e.weapon === 'wreck';
  const how = `${WEAPON[e.weapon]}${e.zone === 'head' && !blast ? ', headshot' : ''}`;
  if (e.by === e.target && e.weapon === 'truck')
    return `${who(e.target)} ${e.target === me ? 'were' : 'was'} run over by a runaway truck`;
  if (e.by === e.target)
    return `${who(e.target)} blew ${e.target === me ? 'yourself' : 'themselves'} up`;
  return `${who(e.by)} ✕ ${e.target === me ? 'you' : nameOf(e.target)} (${how})`;
}

/** The banner a death shows the one who died. */
export function deathBanner(e: Extract<CombatEvent, { type: 'hit' }>, nameOf: NameOf): string {
  if (e.by === e.target) return 'You were killed by your own frag';
  return `Killed by ${nameOf(e.by)} (${WEAPON[e.weapon]}) — respawning`;
}

const clock = (s: number): string => {
  const t = Math.ceil(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/**
 * The score line: your kills (and deaths), the leader, the goal and the clock. While the results
 * show, who won and when the next match starts.
 */
export function matchLine(
  m: MatchStateMessage,
  me: string,
  nameOf: NameOf,
  secondsLeft: number | null,
): string {
  const mine = m.scores.find((s) => s.id === me) ?? { kills: 0, deaths: 0 };
  if (m.phase === 'ended') {
    const next = secondsLeft === null ? '' : ` · next match in ${Math.ceil(secondsLeft)} s`;
    return `${resultText(m, me, nameOf)}${next}`;
  }
  const others = m.scores.filter((s) => s.id !== me);
  const best = others.reduce<(typeof others)[number] | null>(
    (a, s) => (a === null || s.kills > a.kills ? s : a),
    null,
  );
  const leader = best ? ` · best other: ${nameOf(best.id)} ${best.kills}` : '';
  return `You ${mine.kills} K / ${mine.deaths} D${leader} · ${matchGoal(m, secondsLeft)}`;
}

/**
 * The match's target and clock: "first to 25 · 7:42", "first to ∞ · 7:42", "first to 25 · ∞"
 * (a limit the host set to unlimited reads as ∞; the clock is left out until it is known).
 */
export function matchGoal(
  m: Pick<MatchStateMessage, 'scoreLimit' | 'endsAt'>,
  secondsLeft: number | null,
): string {
  const goal = m.scoreLimit === UNLIMITED ? '∞' : String(m.scoreLimit);
  const time = m.endsAt === null ? ' · ∞' : secondsLeft === null ? '' : ` · ${clock(secondsLeft)}`;
  return `first to ${goal}${time}`;
}

/** Who won (a shared win names everyone sharing it). */
export function resultText(m: MatchStateMessage, me: string, nameOf: NameOf): string {
  const w = m.winners;
  if (w.length === 0) return 'Match over — no winner';
  const names = w.map((id) => (id === me ? 'you' : nameOf(id)));
  if (w.length === 1)
    return w[0] === me ? 'Match over — you win!' : `Match over — ${names[0]} wins`;
  return `Match over — shared win: ${names.join(', ')}`;
}
