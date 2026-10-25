import { RIFLE } from '../config/tunables.ts';
import type { HitZone } from './hitbox.ts';
import type { WeaponConfig } from './weapon.ts';

/** Range multiplier: 1 up to falloffStart, linear down to falloffMinMultiplier at falloffEnd. */
export function falloffMultiplier(distance: number, cfg: WeaponConfig = RIFLE): number {
  if (distance <= cfg.falloffStart) return 1;
  if (distance >= cfg.falloffEnd) return cfg.falloffMinMultiplier;
  const t = (distance - cfg.falloffStart) / (cfg.falloffEnd - cfg.falloffStart);
  return 1 + (cfg.falloffMinMultiplier - 1) * t;
}

export function zoneMultiplier(zone: HitZone, cfg: WeaponConfig = RIFLE): number {
  switch (zone) {
    case 'head':
      return cfg.headMultiplier;
    case 'legs':
      return cfg.legMultiplier;
    case 'torso':
      return 1;
  }
}

/** Damage for one bullet. Rounded to 0.1 HP so client and server agree exactly. */
export function computeDamage(zone: HitZone, distance: number, cfg: WeaponConfig = RIFLE): number {
  const raw = cfg.damage * zoneMultiplier(zone, cfg) * falloffMultiplier(distance, cfg);
  return Math.round(raw * 10) / 10;
}

export interface Damageable {
  health: number;
}

/** Apply damage; returns true if this hit was the killing blow. */
export function applyDamage(target: Damageable, amount: number): boolean {
  if (target.health <= 0) return false;
  target.health = Math.max(0, Math.round((target.health - amount) * 10) / 10);
  return target.health === 0;
}
