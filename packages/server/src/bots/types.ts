import type {
  BotPersonalityId,
  DriveGraph,
  MapDefinition,
  SeatId,
  VehicleCondition,
  PlayerInput,
  PlayerState,
  PrimaryId,
  SmokeCloud,
  Vec3,
} from '@wd/shared';
import type { NavGraph } from './nav.ts';

export type BotDifficulty = 'easy' | 'normal' | 'hard';
export type BotBehavior = 'ffa' | 'hunt-humans';

export interface BotConfig {
  readonly id: string;
  readonly seed: number;
  readonly difficulty: BotDifficulty;
  readonly behavior: BotBehavior;
  /** How it plays (`BOT.personalities`); absent: the plain baseline tree. */
  readonly personality?: BotPersonalityId;
}

export interface BotPlayerObservation {
  readonly id: string;
  readonly name: string;
  readonly isBot: boolean;
  readonly health: number;
  readonly ammo: number;
  readonly reserve: number;
  readonly reloadTimer: number;
  readonly grenades: number;
  readonly weapon: 'rifle' | 'sidearm' | 'knife';
  /**
   * The rest is what the player's own HUD shows: this life's primary, the gun in hand's heat
   * (energy guns), coilgun charge (-1 = press spent, release to charge again) and ADS amount,
   * and the primary's rounds left in total (mag + reserve), and the recoil kick the crosshair
   * shows (degrees, up / right of the view: what a player sees and pulls against).
   */
  readonly primary: PrimaryId;
  readonly heat: number;
  readonly charge: number;
  readonly adsAmount: number;
  readonly primaryRounds: number;
  readonly recoilPitch: number;
  readonly recoilYaw: number;
  /** Sprinting, in a tactical sprint burst, and the burst tank (0–1, the HUD's meter). */
  readonly sprinting: boolean;
  readonly tacSprint: boolean;
  readonly tacFuel: number;
  /** On the ground (the HUD knows: a jump lights a pack only in the air). */
  readonly grounded?: boolean;
  /** Jetpack (`JetMode`), flight seconds left and height above the ground (HUD's altitude bar). */
  readonly jet?: number;
  readonly jetFuel?: number;
  readonly jetAlt?: number;
  readonly pos: Vec3;
  readonly eye: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly slot: number;
  /** In a truck: which one and which seat (the HUD shows it). Absent: on foot. */
  readonly seat?: { readonly vehicle: number; readonly seat: SeatId } | null;
}

/**
 * A truck as anyone nearby sees (and hears) it: where it is and how it moves, whether it burns
 * (health share: the smoke every player sees), which seats are free.
 */
export interface BotVehicleView {
  readonly id: number;
  readonly pos: Vec3;
  readonly yaw: number;
  readonly speed: number;
  /** Speed along its heading (negative reversing). */
  readonly forwardSpeed: number;
  readonly condition: VehicleCondition;
  /** Health share 0–1. */
  readonly health: number;
  readonly free: readonly SeatId[];
  readonly hasDriver: boolean;
}

export interface BotVisiblePlayer {
  readonly kind?: 'player';
  readonly id: string;
  readonly name: string;
  readonly isBot: boolean;
  readonly pos: Vec3;
  readonly eye: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly slot: number;
  readonly visibility: number;
  /**
   * Spawn-protected (the shimmer every player sees): shots on them are wasted, so the tree
   * prefers someone else and holds fire on them until it ends.
   */
  readonly protected: boolean;
  /** Reloading (the reload animation every player sees). */
  readonly reloading: boolean;
  /** Sitting in a truck (which one): you can see who rides where. */
  readonly vehicle?: number;
}

export interface BotVisibleDrone {
  readonly kind: 'drone';
  /** Synthetic target id, stable while the owner's current drone is alive. */
  readonly id: string;
  readonly ownerId: string;
  readonly isBot: boolean;
  readonly pos: Vec3;
  readonly eye: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly slot: number;
  readonly visibility: number;
  readonly protected: false;
  readonly reloading: false;
}

export type BotVisibleTarget = BotVisiblePlayer | BotVisibleDrone;

export interface BotMemory {
  readonly id: string;
  readonly pos: Vec3;
  readonly seenAt: number;
  readonly isBot: boolean;
}

export interface BotObservation {
  readonly nowMs: number;
  readonly seq: number;
  readonly map: MapDefinition;
  readonly nav: NavGraph;
  readonly self: BotPlayerObservation;
  readonly visiblePlayers: readonly BotVisiblePlayer[];
  readonly visibleDrones?: readonly BotVisibleDrone[];
  readonly memories: readonly BotMemory[];
  readonly smoke: readonly SmokeCloud[];
  readonly mode: 'standard' | 'knife';
  /** Trucks the bot notices (heard close by, or in sight), and where trucks can drive. */
  readonly vehicles?: readonly BotVehicleView[];
  readonly drive?: DriveGraph | null;
  /** Free jetpacks lying on the map (everyone sees them: glowing pickups). */
  readonly jetpacks?: readonly { readonly id: number; readonly pos: Vec3 }[];
}

export interface DecisionProvider {
  decide(observation: BotObservation, dt: number): PlayerInput;
}

export type PublicPlayerLike = {
  readonly id: string;
  readonly name: string;
  readonly slot: number;
  readonly isBot: boolean;
  readonly state: PlayerState;
};
