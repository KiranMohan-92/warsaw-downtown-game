import { describe, expect, it } from 'vitest';
import { createPlayerState, PRIMARIES, type WeaponDropState } from '@wd/shared';
import { weaponDropPrompt } from './weaponDropPrompt.ts';

const drop = (id: string, x: number, primary: WeaponDropState['primary']): WeaponDropState => ({
  id,
  pos: { x, y: 0, z: 0 },
  primary,
  ammoFraction: 0,
  ttl: 30,
});

describe('weapon drop context prompt', () => {
  it('names the nearest gun, including one whose ammo was already taken', () => {
    const player = createPlayerState({ x: 0, y: 0, z: 0 });
    const drops = [drop('far', 1.5, 'ar7'), drop('near', 0.8, 'coil')];
    expect(weaponDropPrompt(drops, player, false)).toBe(`E  Take ${PRIMARIES.coil.name}`);
    expect(weaponDropPrompt(drops, player, false, 'F')).toBe(`F  Take ${PRIMARIES.coil.name}`);
  });

  it('hides outside range, while dead, in knife mode, or when a truck has priority', () => {
    const player = createPlayerState({ x: 0, y: 0, z: 0 });
    const drops = [drop('gun', 1, 'ar7')];
    expect(weaponDropPrompt(drops, player, true)).toBeNull();
    expect(weaponDropPrompt([drop('far', 1.61, 'ar7')], player, false)).toBeNull();
    player.health = 0;
    expect(weaponDropPrompt(drops, player, false)).toBeNull();
    player.health = 100;
    player.arsenal.mode = 'knife';
    expect(weaponDropPrompt(drops, player, false)).toBeNull();
  });
});
