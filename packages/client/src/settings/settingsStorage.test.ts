import { afterEach, describe, expect, it, vi } from 'vitest';

/** Minimal localStorage for node. */
function stubStorage(init: Record<string, string>): Map<string, string> {
  const m = new Map(Object.entries(init));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  return m;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('settings storage', () => {
  it('hosted (production) builds start online; dev builds start offline', async () => {
    vi.stubEnv('PROD', true);
    vi.resetModules();
    expect((await import('./settings.ts')).DEFAULT_SETTINGS.online).toBe(true);
    vi.stubEnv('PROD', false);
    vi.resetModules();
    expect((await import('./settings.ts')).DEFAULT_SETTINGS.online).toBe(false);
  });

  it('migrates v1 settings but drops their online flag (it was only the old default)', async () => {
    vi.stubEnv('PROD', true);
    vi.resetModules();
    const { loadSettings } = await import('./settings.ts');
    stubStorage({ 'wd.settings.v1': JSON.stringify({ online: false, sensitivity: 3.2 }) });
    const s = loadSettings();
    expect(s.online).toBe(true); // the new hosted default, not the stale v1 false
    expect(s.sensitivity).toBeCloseTo(3.2); // everything else carries over
  });

  it('a v2 choice is kept (an explicit offline sticks), and saving writes v2', async () => {
    vi.stubEnv('PROD', true);
    vi.resetModules();
    const { loadSettings, saveSettings } = await import('./settings.ts');
    const store = stubStorage({ 'wd.settings.v2': JSON.stringify({ online: false }) });
    const s = loadSettings();
    expect(s.online).toBe(false);
    saveSettings({ ...s, sensitivity: 2 });
    expect((JSON.parse(store.get('wd.settings.v2')!) as { sensitivity: number }).sensitivity).toBe(
      2,
    );
  });

  it("cinematic cameras: on by default, the player's choice (and skip intro) persists", async () => {
    vi.resetModules();
    const { loadSettings, saveSettings } = await import('./settings.ts');
    const { PageOverrides } = await import('./pageOverrides.ts');
    const store = stubStorage({});
    const s = loadSettings();
    expect(s.cinematicCameras).toBe(true);
    expect(s.skipIntro).toBe(false);
    // Saved through the page overrides like every menu change (a forced key doesn't matter).
    const page = new PageOverrides();
    page.force(s, 'online', true);
    s.cinematicCameras = false;
    s.skipIntro = true;
    saveSettings(page.toSave(s, ['cinematicCameras', 'skipIntro']));
    const saved = JSON.parse(store.get('wd.settings.v2')!) as Record<string, unknown>;
    expect(saved.cinematicCameras).toBe(false);
    expect(saved.skipIntro).toBe(true);
    const back = loadSettings();
    expect(back.cinematicCameras).toBe(false);
    expect(back.skipIntro).toBe(true);
    // Junk in storage falls back to the defaults.
    stubStorage({ 'wd.settings.v2': JSON.stringify({ cinematicCameras: 'yes', skipIntro: 1 }) });
    expect(loadSettings().cinematicCameras).toBe(true);
    expect(loadSettings().skipIntro).toBe(false);
  });

  it('v2 wins over a leftover v1 key, and a v1 opt-in (true) survives the migration', async () => {
    vi.stubEnv('PROD', false);
    vi.resetModules();
    const { loadSettings } = await import('./settings.ts');
    stubStorage({
      'wd.settings.v1': JSON.stringify({ online: false, sensitivity: 3.2 }),
      'wd.settings.v2': JSON.stringify({ online: false, sensitivity: 2 }),
    });
    expect(loadSettings().sensitivity).toBeCloseTo(2);
    stubStorage({ 'wd.settings.v1': JSON.stringify({ online: true }) });
    expect(loadSettings().online).toBe(true);
  });
});
