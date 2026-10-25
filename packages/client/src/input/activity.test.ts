import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings/settings.ts';
import { activityLevel, LOOK_ACTIVITY_COUNTS, LookActivity } from './activity.ts';

/** Feed `perFrame` counts every frame at `hz` for `seconds`; true if it ever counted as a look. */
function steady(perFrame: number, hz: number, seconds: number): boolean {
  const look = new LookActivity();
  let any = false;
  for (let i = 0; i < seconds * hz; i++) any = look.add(perFrame, (i * 1000) / hz) || any;
  return any;
}

describe('LookActivity', () => {
  it('steady movement below the threshold per frame still counts, at any frame rate', () => {
    expect(10).toBeLessThan(LOOK_ACTIVITY_COUNTS);
    expect(steady(10, 60, 0.2)).toBe(true);
    expect(steady(10, 240, 0.2)).toBe(true);
    // The same hand speed at a high polling rate arrives in smaller pieces: still a look.
    expect(steady(2.5, 240, 0.2)).toBe(true);
    expect(steady(1, 1000, 0.2)).toBe(true);
  });

  it('sensor noise or a resting hand never does', () => {
    // A count now and then decays away before it adds up.
    const look = new LookActivity();
    let any = false;
    for (let i = 0; i < 100; i++) any = look.add(1, i * 100) || any;
    expect(any).toBe(false);
    // A small bump, then stillness, then another: two separate non-looks.
    look.reset();
    expect(look.add(8, 0)).toBe(false);
    expect(look.add(8, 2000)).toBe(false);
  });

  it('one deliberate flick counts at once', () => {
    expect(new LookActivity().add(40, 0)).toBe(true);
  });
});

describe('activityLevel', () => {
  it('a press is 2; held controls or a look are 1; nothing is 0', () => {
    expect(activityLevel(true, true, true)).toBe(2);
    expect(activityLevel(false, true, false)).toBe(1);
    expect(activityLevel(false, false, true)).toBe(1);
    expect(activityLevel(false, false, false)).toBe(0);
  });
});

describe('Input.consumeActivity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function makeInput() {
    const target = { addEventListener: () => {} };
    vi.stubGlobal('document', { ...target, pointerLockElement: null });
    vi.stubGlobal('window', target);
    const { Input } = await import('./Input.ts');
    const input = new Input(
      {} as HTMLCanvasElement,
      () => DEFAULT_SETTINGS,
      () => 1,
    );
    input.locked = true;
    const key = (code: string, down: boolean): void =>
      (input as unknown as { onKey(e: Partial<KeyboardEvent>, down: boolean): void }).onKey(
        { code, repeat: false, preventDefault: () => {} },
        down,
      );
    return { input, key };
  }

  it('controls held since before a moment started still count (as activity, not as a press)', async () => {
    const { input, key } = await makeInput();
    expect(input.consumeActivity()).toBe(0);
    key('KeyW', true);
    expect(input.consumeActivity()).toBe(2); // the press edge, once
    // Still holding W when the intro / victory shot starts a moment later: it must skip.
    expect(input.consumeActivity()).toBe(1);
    expect(input.consumeActivity()).toBe(1);
    key('KeyW', false);
    expect(input.consumeActivity()).toBe(0);
  });

  it('an unbound key is a press too; scripted holds are held, scripted taps are presses', async () => {
    const { input, key } = await makeInput();
    key('F9', true);
    expect(input.consumeActivity()).toBe(2);
    expect(input.consumeActivity()).toBe(0);
    input.scripted = { buttons: 1, moveX: 0, moveZ: 0 };
    expect(input.consumeActivity()).toBe(1);
    input.scripted = { buttons: 0, moveX: 0, moveZ: 0 };
    input.scriptedTaps = 4;
    expect(input.consumeActivity()).toBe(2);
  });
});
