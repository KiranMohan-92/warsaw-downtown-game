import type { PlayerInput } from '../sim/input.ts';
import {
  clonePlayerState,
  type CharacterBody,
  type PlayerState,
  type StepEnv,
} from '../sim/player.ts';
import { stepPlayerInCrowd, type CrowdMember } from '../sim/playerCollision.ts';
import type { SnapshotPlayer } from './protocol.ts';
import { applySnapshotMove, snapshotError } from './snapshot.ts';

/** One locally predicted step: the input sent and the state it produced. */
export interface PredictedStep {
  input: PlayerInput;
  /** Predicted state right after applying `input` (a private copy). */
  after: PlayerState;
}

/**
 * The character body the replay drives. `setGrounded` (Rapier) lets the replay restore the
 * controller's ground contact too, so snapping and step-up behave as they did on the server.
 */
export type ReplayBody = CharacterBody & { setGrounded?(grounded: boolean): void };

export interface ReconcileResult {
  /** The local player's state now: the prediction if it held, else server state + replay. */
  state: PlayerState;
  /**
   * The acknowledged step (the reference for the next snapshot, which often carries the same
   * ack) followed by the unacknowledged ones (seq > ack), with corrected predictions after a
   * replay.
   */
  pending: PredictedStep[];
  /** True if the prediction was wrong and the state was rebuilt from the server's. */
  corrected: boolean;
  /** Prediction error at the acknowledged step (m or m/s; Infinity = stance/life mismatch). */
  error: number;
}

/** Below this the prediction counts as exact (float noise, not a misprediction). */
export const RECONCILE_TOLERANCE = 1e-3;

/**
 * Client-side reconciliation. `pending` holds every predicted step not yet acknowledged, in
 * sequence order; `server` is the local player's entry in the newest snapshot.
 *
 * - Steps before `server.ack` are settled and dropped. The acknowledged step stays at the head:
 *   snapshots come at 30 Hz and inputs at 60 Hz, so the next snapshot often repeats the ack
 *   (and if the server idled us meanwhile, that comparison is what catches it).
 * - If the prediction for the acknowledged step matches the server (within `tolerance`), the
 *   current prediction stands (no replay: the common case, since both sides run the same code).
 * - Otherwise the state is reset to the server's (on top of the predicted copy for the fields a
 *   snapshot doesn't carry) and every unacknowledged input is replayed through `stepPlayer`.
 *
 * Pure except for `body`, which the replay moves (it's the physics adapter for this player).
 */
export function reconcile(
  current: PlayerState,
  pending: readonly PredictedStep[],
  server: SnapshotPlayer,
  body: ReplayBody,
  dt: number,
  opts: {
    tolerance?: number;
    /** Always rebuild and replay (e.g. the server respawned the player: `life` changed). */
    forceReset?: boolean;
    /**
     * State to rebuild on for the fields snapshots don't carry (arsenal, timers). Default: the
     * acknowledged prediction. After a respawn, pass a fresh spawn state (the server reset it).
     */
    base?: PlayerState;
    /**
     * The other players the replay bumps into (`sim/playerCollision.ts`), as the prediction
     * did: without them a replay in contact would walk through the very player it was pushed by.
     */
    crowd?: { members: readonly CrowdMember[]; selfId: string };
    /** What else the replay meets (vehicles), as the prediction did. */
    env?: StepEnv;
    /** Called once a replay is decided, before its first step (e.g. forget predicted props). */
    beforeReplay?: () => void;
    /** World interactions after each replayed player step (e.g. authoritative weapon drops). */
    afterStep?: (state: PlayerState, input: PlayerInput, previousButtons: number) => void;
  } = {},
): ReconcileResult {
  const tolerance = opts.tolerance ?? RECONCILE_TOLERANCE;
  const acked = pending.find((s) => s.input.seq === server.ack);
  const rest = pending.filter((s) => s.input.seq > server.ack);
  const error = acked && !opts.forceReset ? snapshotError(acked.after, server) : Infinity;
  if (error <= tolerance) {
    return { state: current, pending: [acked!, ...rest], corrected: false, error };
  }

  opts.beforeReplay?.();
  // Rebuild: the acknowledged prediction (or, with none, the oldest pending / current state)
  // supplies the fields snapshots don't carry; the server supplies the rest.
  const base = clonePlayerState(opts.base ?? acked?.after ?? current);
  applySnapshotMove(base, server);
  // Button edges (jump/fire presses) replay relative to the input before the first replayed one.
  if (acked && !opts.base && !server.own) base.prevButtons = acked.input.buttons;
  // Position first: standing up is checked for headroom where the server says we are.
  body.setPosition(base.move.pos);
  body.setCrouched(base.move.crouched);
  if (base.move.prone) body.setProne?.(true);
  body.setGrounded?.(base.move.grounded);

  // The server's state is now the reference for this ack (what a repeat snapshot is checked
  // against). Its input only matters for the sequence number and button edges.
  const replayed: PredictedStep[] =
    server.ack >= 0
      ? [
          {
            input: acked?.input ?? {
              seq: server.ack,
              moveX: 0,
              moveZ: 0,
              yaw: base.view.yaw,
              pitch: base.view.pitch,
              buttons: base.prevButtons,
            },
            after: clonePlayerState(base),
          },
        ]
      : [];
  for (const step of rest) {
    const previousButtons = base.prevButtons;
    stepPlayerInCrowd(
      base,
      step.input,
      dt,
      body,
      opts.crowd?.members,
      opts.crowd?.selfId ?? '',
      opts.env,
    );
    opts.afterStep?.(base, step.input, previousButtons);
    replayed.push({ input: step.input, after: clonePlayerState(base) });
  }
  return { state: base, pending: replayed, corrected: true, error };
}
