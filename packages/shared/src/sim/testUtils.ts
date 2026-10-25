import type { Vec3 } from '../math/vec3.ts';
import { SIM_DT } from '../config/tunables.ts';
import { emptyInput, type PlayerInput } from './input.ts';
import {
  stepPlayer,
  type CharacterBody,
  type MoveResult,
  type PlayerEvent,
  type PlayerState,
} from './player.ts';

/** Infinite flat ground at y = 0, no walls. For pure movement tests without WASM. */
export class FlatGroundBody implements CharacterBody {
  feet: Vec3;
  constructor(feet: Vec3 = { x: 0, y: 0, z: 0 }) {
    this.feet = { ...feet };
  }
  move(delta: Vec3): MoveResult {
    const y = Math.max(0, this.feet.y + delta.y);
    const moved = { x: delta.x, y: y - this.feet.y, z: delta.z };
    this.feet = { x: this.feet.x + delta.x, y, z: this.feet.z + delta.z };
    return { moved, grounded: y <= 1e-6 && delta.y <= 0 };
  }
  setCrouched(): boolean {
    return true;
  }
  setPosition(feet: Vec3): void {
    this.feet = { ...feet };
  }
}

/** Run `seconds` of fixed steps with a constant (or per-step) input. */
export function run(
  p: PlayerState,
  body: CharacterBody,
  seconds: number,
  input: Partial<PlayerInput> | ((step: number) => Partial<PlayerInput>),
  onStep?: (events: PlayerEvent[], step: number) => void,
): PlayerEvent[] {
  const all: PlayerEvent[] = [];
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    const partial = typeof input === 'function' ? input(i) : input;
    const events = stepPlayer(p, { ...emptyInput(i), ...partial }, SIM_DT, body);
    onStep?.(events, i);
    all.push(...events);
  }
  return all;
}
