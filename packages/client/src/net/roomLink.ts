/**
 * What the game needs of a joined match room: the Colyseus SDK's `Room` (online) or the local
 * practice room (`practiceRoom.ts`: the server's `MatchSim` and bots in a worker). Both carry the
 * same messages, so everything past the join (prediction, scores, kill feed, kill cam) is one
 * code path.
 */
export interface MatchRoomLink {
  readonly roomId: string;
  readonly sessionId: string;
  readonly reconnection: { minUptime: number };
  /** Subscribe to a message type; returns the unsubscribe. */
  onMessage<T = unknown>(type: string, cb: (msg: T) => void): () => void;
  send(type: string, msg?: unknown): void;
  leave(consented?: boolean): Promise<unknown>;
  onDrop(cb: () => void): unknown;
  onReconnect(cb: () => void): unknown;
  /** The room is gone (`reason`: why, when known). */
  onLeave(cb: (code: number, reason?: string) => void): unknown;
}
