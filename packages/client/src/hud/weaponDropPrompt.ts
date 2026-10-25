import { nearestDrop, PRIMARIES, type PlayerState, type WeaponDropState } from '@wd/shared';

/** The same nearest-drop selection as the shared E action; a truck seat owns the key first. */
export function weaponDropPrompt(
  drops: readonly WeaponDropState[],
  player: PlayerState,
  truckPriority: boolean,
  key = 'E',
): string | null {
  if (player.health <= 0 || player.arsenal.mode === 'knife' || player.seat || player.drone?.alive)
    return null;
  const drop = nearestDrop(drops, player.move.pos, truckPriority);
  return drop ? `${key}  Take ${PRIMARIES[drop.primary].name}` : null;
}
