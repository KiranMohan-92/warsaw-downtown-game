import type { Vec3, WorldRaycaster } from '@wd/shared';
import type { BlastContext } from './blastAcoustics.ts';

/** Presentation cover uses visible surfaces, independently of gameplay collision helpers. */
export function resolvePointSound(
  source: Vec3,
  listener: Vec3,
  forward: Vec3,
  world: WorldRaycaster,
  origin: Vec3 = source,
): { distance: number; context: BlastContext } {
  const dx = listener.x - origin.x;
  const dy = listener.y - origin.y;
  const dz = listener.z - origin.z;
  const rayDistance = Math.hypot(dx, dy, dz);
  const hit =
    rayDistance > 0.05
      ? (world.castVisibleRay ?? world.castRay).call(
          world,
          origin,
          { x: dx / rayDistance, y: dy / rayDistance, z: dz / rayDistance },
          rayDistance,
        )
      : null;
  return {
    distance: Math.hypot(listener.x - source.x, listener.y - source.y, listener.z - source.z),
    context: {
      source,
      listener,
      forward,
      blocked: !!hit && hit.visible && hit.distance < rayDistance - 0.05,
    },
  };
}

/** Resolve presentation audio only after this frame's drone/chase/cinematic camera is ready. */
export class BlastAudioQueue {
  private readonly pending: Vec3[] = [];

  push(source: Vec3): void {
    if (this.pending.length >= 64) this.pending.shift();
    this.pending.push({ ...source });
  }

  flush(
    listener: Vec3,
    forward: Vec3,
    world: WorldRaycaster,
    play: (distance: number, context: BlastContext) => void,
  ): void {
    for (const source of this.pending) {
      const origin = { x: source.x, y: source.y + 0.12, z: source.z };
      const { distance, context } = resolvePointSound(source, listener, forward, world, origin);
      play(distance, context);
    }
    this.pending.length = 0;
  }
}
