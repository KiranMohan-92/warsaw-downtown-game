import { SKATEBOARD } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';

/**
 * The match's one skateboard (Kiran): it starts at the map's secret spot; a living, eligible
 * player who walks over it rides it (`MoveState.board`) until they die; it then lies where they
 * fell for anyone else. A respawn never brings it back (a new life starts without it). Pure and
 * deterministic: the server owns it online, the game loop offline.
 */
export interface BoardState {
  /** Where it lies (feet level), or the rider's feet while ridden. */
  pos: Vec3;
  /** Who rides it (null = lying on the ground). */
  rider: string | null;
}

export interface BoardRider {
  id: string;
  pos: Vec3;
  alive: boolean;
  /** May pick it up (bots don't: their navigation assumes walking). Default true. */
  eligible?: boolean;
  /** Lying prone: you ride standing, so a crawl over the board doesn't take it. */
  prone?: boolean;
}

export type BoardEvent = { type: 'pickup'; by: string } | { type: 'drop'; by: string; pos: Vec3 };

export const createBoard = (pos: Vec3): BoardState => ({ pos: { ...pos }, rider: null });

/**
 * One step: a rider who died (or left: missing from `players`) drops it where they were; a free
 * board goes to the first eligible living player in reach (list order, so ties are stable).
 * The caller then sets each player's `move.board` to `board.rider === id`.
 */
export function stepBoard(board: BoardState, players: readonly BoardRider[]): BoardEvent[] {
  const events: BoardEvent[] = [];
  if (board.rider !== null) {
    const r = players.find((p) => p.id === board.rider);
    if (r && r.alive) {
      board.pos = { ...r.pos };
      return events;
    }
    // Died (or left): it stays where they fell (their last known feet).
    if (r) board.pos = { ...r.pos };
    events.push({ type: 'drop', by: board.rider, pos: { ...board.pos } });
    board.rider = null;
    return events; // no same-step pickup: it lands first
  }
  for (const p of players) {
    if (!p.alive || p.eligible === false || p.prone) continue;
    const dx = p.pos.x - board.pos.x;
    const dz = p.pos.z - board.pos.z;
    if (Math.hypot(dx, dz) > SKATEBOARD.pickupRadius) continue;
    if (Math.abs(p.pos.y - board.pos.y) > SKATEBOARD.pickupHeight) continue;
    board.rider = p.id;
    events.push({ type: 'pickup', by: p.id });
    break;
  }
  return events;
}

/** Where the board lies at match start: cast down from the map's spot onto its floor. */
export function boardSpawn(spot: Vec3, castDown: (from: Vec3) => { point: Vec3 } | null): Vec3 {
  const hit = castDown(spot);
  return hit ? { ...hit.point } : { ...spot };
}
