import { JETPACK, MOVEMENT, PRONE, RIFLE, SLIDE, TAC_SPRINT } from '../config/tunables.ts';
import { approach, DEG } from '../math/vec3.ts';
import { hashSeed, mulberry32 } from '../math/rng.ts';
import { Button, isDown, pressed, type PlayerInput } from './input.ts';

export type WeaponConfig = typeof RIFLE;

/** Semi-auto trigger buffer (s). */
const SEMI_BUFFER = 0.1;

/** Weapon state. Plain data, mutated in place by `stepWeapon`, cloneable for prediction. */
export interface WeaponState {
  ammo: number;
  reserve: number;
  /** Seconds until the next shot may fire (can go negative within a step to carry remainder). */
  cooldown: number;
  /** Seconds remaining on the current reload; 0 = not reloading. */
  reloadTimer: number;
  reloadDuration: number;
  /** Index into the recoil pattern for the next shot. */
  shotIndex: number;
  timeSinceShot: number;
  /** Extra spread from sustained fire (degrees). */
  bloom: number;
  /** Aim offset from recoil, added to the view (degrees). */
  recoilPitch: number;
  recoilYaw: number;
  /** 0 = hip, 1 = fully aimed. */
  adsAmount: number;
  /** Remaining sprint-out time before firing is allowed. */
  sprintBlockTimer: number;
  /** Total shots fired this life: seeds deterministic spread. */
  shotCounter: number;
  /** Semi-auto: a trigger press waiting for the cooldown (input buffer, s). */
  queuedShot: number;
  /**
   * Coilgun charge held so far (s); -1 = this press already fired (release to charge again).
   * Always 0 for guns without `chargeTime`.
   */
  charge: number;
  /** Energy weapons: heat 0..1 and the overheat lockout left (s); always 0 otherwise. */
  heat: number;
  overheat: number;
}

export const createWeaponState = (cfg: WeaponConfig = RIFLE): WeaponState => ({
  ammo: cfg.magazineSize,
  reserve: cfg.reserveAmmo,
  cooldown: 0,
  reloadTimer: 0,
  reloadDuration: 0,
  shotIndex: 0,
  timeSinceShot: 99,
  bloom: 0,
  recoilPitch: 0,
  recoilYaw: 0,
  adsAmount: 0,
  sprintBlockTimer: 0,
  shotCounter: 0,
  queuedShot: 0,
  charge: 0,
  heat: 0,
  overheat: 0,
});

export interface WeaponContext {
  sprinting: boolean;
  /** Tactical sprint burst: the gun is held lower, so the sprint-out is longer. */
  tacSprinting?: boolean;
  crouched: boolean;
  /** Prone: steadier hip fire and less recoil. */
  prone?: boolean;
  /** Sliding: hip spread a little worse than crouch-walking (whatever the speed), slower ADS. */
  sliding?: boolean;
  grounded: boolean;
  /**
   * On a jetpack in the air: its steadiness 0–1 (`flightSteadiness`; absent = not flying). The
   * jump's airborne spread × `JETPACK.spreadScale`, less in a steady aimed hover; more recoil.
   */
  flying?: number;
  /** Horizontal speed (m/s), for movement spread. */
  speed: number;
  walkSpeed: number;
  /** Stable per-player id folded into spread seeds. */
  ownerSeed: number;
}

export interface ShotFired {
  /** Recoil-adjusted aim (radians), before spread. */
  yaw: number;
  pitch: number;
  /** Spread cone half-angle used for this shot (degrees). */
  spreadDeg: number;
  /** Deterministic seed for this shot's spread sample. */
  seed: number;
  shotCounter: number;
}

export type WeaponEvent =
  | { type: 'shot'; shot: ShotFired }
  | { type: 'dryFire' }
  /** A coilgun began charging (sound/visual cue; the shot follows after `chargeTime`). */
  | { type: 'chargeStart'; time: number }
  | { type: 'reloadStart'; duration: number; empty: boolean }
  | { type: 'reloadEnd' }
  /** An energy weapon overheated (vent hiss; the trigger is locked for `lockout` s). */
  | { type: 'overheat'; lockout: number };

/** Current spread cone half-angle in degrees. */
export function currentSpread(
  w: WeaponState,
  ctx: WeaponContext,
  cfg: WeaponConfig = RIFLE,
): number {
  const sp = cfg.spread;
  const hip = ctx.prone
    ? sp.hipCrouch * PRONE.spreadMultiplier
    : ctx.crouched
      ? sp.hipCrouch
      : sp.hipStand;
  let base = hip + (sp.ads - hip) * w.adsAmount;
  // A slide spreads like crouch-walking (not by its speed), × SLIDE.spreadMultiplier at the hip.
  const speed = ctx.sliding ? MOVEMENT.crouchSpeed : ctx.speed;
  const moveFrac = Math.min(1.5, speed / Math.max(0.01, ctx.walkSpeed));
  base += sp.moving * moveFrac * (1 - 0.85 * w.adsAmount);
  if (ctx.sliding) base *= 1 + (SLIDE.spreadMultiplier - 1) * (1 - w.adsAmount);
  if (ctx.flying !== undefined) {
    const steady = JETPACK.hoverAdsSteady * w.adsAmount * Math.max(0, Math.min(1, ctx.flying));
    base += sp.airborne * JETPACK.spreadScale * (1 - steady);
  } else if (!ctx.grounded) base += sp.airborne;
  const bloomMul = 1 + (sp.adsBloomMultiplier - 1) * w.adsAmount;
  return base + w.bloom * bloomMul;
}

function startReload(w: WeaponState, cfg: WeaponConfig, events: WeaponEvent[]): void {
  if (w.reloadTimer > 0 || w.reserve <= 0 || w.ammo >= cfg.magazineSize) return;
  const empty = w.ammo === 0;
  w.reloadDuration = empty ? cfg.reloadEmptyTime : cfg.reloadTime;
  w.charge = 0;
  w.reloadTimer = w.reloadDuration;
  events.push({ type: 'reloadStart', duration: w.reloadDuration, empty });
}

/**
 * Advance the weapon one simulation step. Fire rate is exact over time: the cooldown carries its
 * remainder, so 720 RPM fires 12 shots/s regardless of step size.
 */
export function stepWeapon(
  w: WeaponState,
  input: PlayerInput,
  prevButtons: number,
  dt: number,
  ctx: WeaponContext,
  cfg: WeaponConfig = RIFLE,
): WeaponEvent[] {
  const events: WeaponEvent[] = [];
  const fireHeld = isDown(input.buttons, Button.Fire);
  const adsHeld = isDown(input.buttons, Button.Ads);
  const reloading = (): boolean => w.reloadTimer > 0;

  // ADS eases in/out (slower while sliding); not while sprinting.
  const adsTarget = adsHeld && !ctx.sprinting ? 1 : 0;
  const adsTime = cfg.adsTime * (ctx.sliding ? SLIDE.adsTimeMultiplier : 1);
  w.adsAmount = approach(w.adsAmount, adsTarget, dt / adsTime);

  // Sprinting keeps the weapon lowered; firing needs a short sprint-out.
  // A tactical sprint holds it lower still: a longer sprint-out (`TAC_SPRINT.sprintOutMultiplier`).
  w.sprintBlockTimer = ctx.sprinting
    ? cfg.sprintToFireTime * (ctx.tacSprinting ? TAC_SPRINT.sprintOutMultiplier : 1)
    : Math.max(0, w.sprintBlockTimer - dt);

  // Reload progress
  if (reloading()) {
    w.reloadTimer -= dt;
    if (w.reloadTimer <= 0) {
      const needed = cfg.magazineSize - w.ammo;
      const taken = Math.min(needed, w.reserve);
      w.ammo += taken;
      w.reserve -= taken;
      w.reloadTimer = 0;
      events.push({ type: 'reloadEnd' });
    }
  }
  if (pressed(input.buttons, prevButtons, Button.Reload)) startReload(w, cfg, events);

  // Firing. Full-auto fires while held; semi-auto fires once per press, with a short input
  // buffer so a tap landing just before the cooldown ends still fires.
  const firePressed = pressed(input.buttons, prevButtons, Button.Fire);
  w.queuedShot = firePressed ? SEMI_BUFFER : Math.max(0, w.queuedShot - dt);
  const charged = cfg.chargeTime > 0;
  w.cooldown = Math.max(w.cooldown - dt, fireHeld && !cfg.semiAuto ? -dt : 0);
  w.timeSinceShot += dt;
  const interval = 60 / cfg.roundsPerMinute;
  const heat = cfg.heat;
  // Energy weapons: vent during the lockout, cool after a pause in firing.
  if (heat) {
    if (w.overheat > 0) {
      w.overheat = Math.max(0, w.overheat - dt);
      w.heat = heat.lockout > 0 ? Math.min(w.heat, w.overheat / heat.lockout) : 0;
    } else if (w.timeSinceShot > heat.coolDelay) {
      w.heat = Math.max(0, w.heat - heat.coolRate * dt);
    }
  }
  const canFire = (): boolean =>
    !reloading() && w.sprintBlockTimer <= 0 && !ctx.sprinting && w.overheat <= 0;
  if (charged) {
    // Hold to charge (only while the gun could fire this press); release — or the hands being
    // busy, which strips Fire — resets it first, so a stripped tick can never release a shot.
    // A shot spends the press: the next one needs a fresh press and a full charge.
    if (!fireHeld) w.charge = 0;
    else if (w.charge >= 0 && canFire() && w.ammo > 0 && w.cooldown <= 0) {
      if (w.charge === 0) events.push({ type: 'chargeStart', time: cfg.chargeTime });
      w.charge += dt;
    }
  }
  // An empty charged gun never charges, so a fresh press pulls the trigger outright: the dry
  // fire and the reload below (the auto reload may have been cancelled by a switch).
  const trigger = charged
    ? fireHeld && (w.charge >= cfg.chargeTime || (w.ammo <= 0 && firePressed))
    : cfg.semiAuto
      ? w.queuedShot > 0
      : fireHeld;
  if (trigger && canFire()) {
    if (w.ammo <= 0) {
      if (firePressed) events.push({ type: 'dryFire' });
      startReload(w, cfg, events);
    }
    while (w.cooldown <= 0 && w.ammo > 0) {
      w.queuedShot = 0;
      if (w.timeSinceShot > cfg.recoil.patternResetTime) w.shotIndex = 0;
      const spreadDeg = currentSpread(w, ctx, cfg);
      const seed = hashSeed(ctx.ownerSeed, w.shotCounter);
      events.push({
        type: 'shot',
        shot: {
          yaw: input.yaw - w.recoilYaw * DEG,
          pitch: input.pitch + w.recoilPitch * DEG,
          spreadDeg,
          seed,
          shotCounter: w.shotCounter,
        },
      });
      applyRecoil(w, ctx, cfg, seed);
      if (!heat) w.ammo -= 1;
      w.shotCounter += 1;
      w.cooldown += interval;
      w.timeSinceShot = 0;
      w.bloom = Math.min(cfg.spread.bloomMax, w.bloom + cfg.spread.bloomPerShot);
      if (charged) w.charge = -1;
      if (heat) {
        w.heat = Math.min(1, w.heat + heat.perShot);
        if (w.heat >= 1 - 1e-9) {
          w.overheat = heat.lockout;
          events.push({ type: 'overheat', lockout: heat.lockout });
          break;
        }
      }
      if (cfg.semiAuto) break;
    }
    if (w.ammo === 0 && w.reserve > 0 && !reloading()) startReload(w, cfg, events);
  }

  // Recovery
  // Bloom only recovers once the gun has stopped cycling.
  if (w.timeSinceShot > interval * 1.5) {
    w.bloom = Math.max(0, w.bloom - cfg.spread.bloomRecovery * dt);
  }
  if (w.timeSinceShot > cfg.recoil.recoveryDelay) {
    const r = cfg.recoil.recoveryRate * dt;
    const mag = Math.hypot(w.recoilPitch, w.recoilYaw);
    if (mag <= r) {
      w.recoilPitch = 0;
      w.recoilYaw = 0;
    } else {
      w.recoilPitch -= (w.recoilPitch / mag) * r;
      w.recoilYaw -= (w.recoilYaw / mag) * r;
    }
  }
  return events;
}

function applyRecoil(w: WeaponState, ctx: WeaponContext, cfg: WeaponConfig, seed: number): void {
  const pattern = cfg.recoil.pattern;
  const tailStart = Math.max(0, pattern.length - 8);
  const idx =
    w.shotIndex < pattern.length
      ? w.shotIndex
      : tailStart + ((w.shotIndex - pattern.length) % (pattern.length - tailStart));
  const [kickPitch, kickYaw] = pattern[idx] ?? [0, 0];
  let mul = 1 + (cfg.recoil.adsMultiplier - 1) * w.adsAmount;
  if (ctx.crouched) mul *= cfg.recoil.crouchMultiplier;
  if (ctx.prone) mul *= PRONE.recoilMultiplier;
  if (ctx.flying !== undefined) mul *= JETPACK.recoilMultiplier;
  const jitter = (mulberry32(seed ^ 0x9e3779b9)() * 2 - 1) * cfg.recoil.yawJitter;
  w.recoilPitch += kickPitch * mul;
  w.recoilYaw += (kickYaw + jitter) * mul;
  w.shotIndex += 1;
}
