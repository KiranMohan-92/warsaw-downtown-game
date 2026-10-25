import type { Vec3, WorldRaycaster } from '@wd/shared';
import { resolvePointSound } from './BlastAudioQueue.ts';
import type { BlastContext } from './blastAcoustics.ts';

export type RemoteShotKind = 'rifle' | 'sidearm' | 'coil';

/** Resolve remote shots once this frame's listener camera is established. */
export class RemoteShotAudioQueue {
  private readonly pending: { source: Vec3; kind: RemoteShotKind }[] = [];

  push(source: Vec3, kind: RemoteShotKind): void {
    if (this.pending.length >= 64) this.pending.shift();
    this.pending.push({ source: { ...source }, kind });
  }

  flush(
    listener: Vec3,
    forward: Vec3,
    world: WorldRaycaster,
    play: (kind: RemoteShotKind, distance: number, context: BlastContext) => void,
  ): void {
    for (const { source, kind } of this.pending) {
      if (
        kind === 'coil' &&
        Math.hypot(listener.x - source.x, listener.y - source.y, listener.z - source.z) > 25
      )
        continue;
      const { distance, context } = resolvePointSound(source, listener, forward, world);
      play(kind, distance, context);
    }
    this.pending.length = 0;
  }
}
