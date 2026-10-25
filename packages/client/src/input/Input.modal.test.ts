import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../settings/settings.ts';
import { Input, type InputModal } from './Input.ts';

/** Event targets for `document` and `window` (the client tests run in node). */
type Listener = (e: unknown) => void;
const make = (): { on: Map<string, Listener[]>; fire: (t: string, e: unknown) => void } => {
  const on = new Map<string, Listener[]>();
  return { on, fire: (t, e) => (on.get(t) ?? []).forEach((cb) => cb(e)) };
};
const doc = make();
const win = make();
const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
beforeAll(() => {
  for (const k of ['document', 'window']) saved[k] = g[k];
  const target = (t: ReturnType<typeof make>) => ({
    addEventListener: (type: string, cb: Listener) =>
      t.on.set(type, [...(t.on.get(type) ?? []), cb]),
  });
  g.document = { ...target(doc), pointerLockElement: null };
  g.window = target(win);
});
afterAll(() => {
  for (const k of ['document', 'window']) g[k] = saved[k];
});

const key = (code: string, down: boolean, repeat = false) =>
  doc.fire(down ? 'keydown' : 'keyup', { code, repeat, preventDefault: () => {} });

describe('Input with a modal (chat) taking keys', () => {
  it('a consumed key release still lets go of the action it holds', () => {
    const settings: Settings = structuredClone(DEFAULT_SETTINGS);
    // Quick chat rebound to a digit (the wheel consumes digits while it is open).
    settings.keybinds.quickChat = ['Digit4', ''];
    settings.keybinds.secondary = ['Digit2', ''];
    const input = new Input(
      {} as HTMLCanvasElement,
      () => settings,
      () => 1,
    );
    input.locked = true;
    let wheelOpen = false;
    let scoreboard = false;
    const modal: InputModal = {
      key: (code) => (wheelOpen || scoreboard) && /^Digit/.test(code),
      button: () => false,
      look: () => false,
    };
    input.modal = modal;
    key('Digit4', true); // opens the wheel (not consumed yet)
    expect(input.held('quickChat')).toBe(true);
    wheelOpen = true;
    key('Digit4', false); // consumed by the wheel…
    expect(input.held('quickChat')).toBe(false); // …but the key is up
    wheelOpen = false;

    key('Digit2', true); // the sidearm key held…
    expect(input.held('secondary')).toBe(true);
    scoreboard = true;
    key('Digit2', false); // …released while the scoreboard eats digits
    expect(input.held('secondary')).toBe(false);
    // A consumed press never holds anything.
    key('Digit2', true);
    expect(input.held('secondary')).toBe(false);
  });
});
