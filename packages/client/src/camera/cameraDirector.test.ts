import { describe, expect, it } from 'vitest';
import { MATCH } from '@wd/shared';
import { CameraDirector, CINE, type KillInfo } from './cameraDirector.ts';

const byPlayer: KillInfo = {
  killer: 'bot-3',
  killerName: '[BOT] Wiktor',
  weapon: 'AR-7 rifle',
  distance: 23,
  headshot: true,
  killMs: 12_000,
};
const ownFrag: KillInfo = { ...byPlayer, killer: null, killerName: 'Your own frag' };

/** Advance `seconds` in 60 Hz frames. */
function run(d: CameraDirector, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) d.update(1 / 60);
}

describe('CameraDirector', () => {
  it('alive → death (pull-out) → kill cam → respawn cuts back to first person', () => {
    const d = new CameraDirector();
    expect(d.mode).toBe('play');
    expect(d.outside).toBe(false);
    d.died(byPlayer);
    expect(d.mode).toBe('death');
    expect(d.outside).toBe(true);
    expect(d.takeEntered()).toBe(true);
    expect(d.takeEntered()).toBe(false);
    run(d, CINE.deathPull - 0.05);
    expect(d.mode).toBe('death');
    run(d, 0.1);
    expect(d.mode).toBe('killcam');
    expect(d.takeEntered()).toBe(true);
    expect(d.kill?.killer).toBe('bot-3');
    // The replay runs for its length, then holds its last frame until the respawn.
    run(d, 1);
    expect(d.replayTime).toBeGreaterThan(0.9);
    run(d, 5);
    expect(d.mode).toBe('killcam');
    expect(d.replayTime).toBe(CINE.killcamLength);
    d.respawned();
    expect(d.mode).toBe('play');
    expect(d.kill).toBeNull();
    expect(d.outside).toBe(false);
  });

  it('an own frag (no killer) orbits the body instead', () => {
    const d = new CameraDirector();
    d.died(ownFrag);
    run(d, CINE.deathPull + 0.05);
    expect(d.mode).toBe('orbit');
    expect(d.deathShot).toBe(true);
    d.respawned();
    expect(d.mode).toBe('play');
  });

  it('the pull-out plus the replay fit in the 3 s respawn wait', () => {
    expect(CINE.deathPull + CINE.killcamLength).toBeLessThanOrEqual(MATCH.respawnDelay);
  });

  it('intro: plays its length, or any input hands control straight back', () => {
    const d = new CameraDirector();
    expect(d.startIntro()).toBe(true);
    expect(d.mode).toBe('intro');
    expect(d.startIntro()).toBe(false); // already playing
    run(d, CINE.introDuration + 0.05);
    expect(d.mode).toBe('play');
    d.startIntro();
    run(d, 0.5);
    expect(d.skip()).toBe(true);
    expect(d.mode).toBe('play');
    expect(d.skip()).toBe(false); // nothing to skip in first person
  });

  it('death moments are not skipped by input (the respawn decides)', () => {
    const d = new CameraDirector();
    d.died(byPlayer);
    expect(d.skip()).toBe(false);
    expect(d.mode).toBe('death');
  });

  it('dying during the intro replaces it with the death cam', () => {
    const d = new CameraDirector();
    d.startIntro();
    d.died(byPlayer);
    expect(d.mode).toBe('death');
  });

  it('results → victory (over a death moment) → next match back to first person', () => {
    const d = new CameraDirector();
    d.died(byPlayer);
    d.matchEnded();
    expect(d.mode).toBe('victory');
    // A respawn during the results keeps the victory shot; so does a death.
    d.respawned();
    d.died(byPlayer);
    expect(d.mode).toBe('victory');
    run(d, 3);
    expect(d.mode).toBe('victory');
    d.matchStarted();
    expect(d.mode).toBe('play');
  });

  it('the victory shot is skippable (the player can move in the results)', () => {
    const d = new CameraDirector();
    d.matchEnded();
    expect(d.skip()).toBe(true);
    expect(d.mode).toBe('play');
    d.matchStarted();
    expect(d.mode).toBe('play');
  });

  it('respawning only ends death moments', () => {
    const d = new CameraDirector();
    d.startIntro();
    d.respawned();
    expect(d.mode).toBe('intro');
  });

  it('the setting off: nothing leaves first person, and a running shot cuts back', () => {
    const d = new CameraDirector();
    d.died(byPlayer);
    d.setEnabled(false);
    expect(d.mode).toBe('play');
    expect(d.startIntro()).toBe(false);
    d.died(byPlayer);
    d.matchEnded();
    expect(d.mode).toBe('play');
    d.setEnabled(true);
    expect(d.startIntro()).toBe(true);
  });

  it('previews (the test hook) end on their own', () => {
    const d = new CameraDirector();
    d.startPreview('death', CINE.deathPull + 1, byPlayer);
    expect(d.preview).toBe(true);
    run(d, CINE.deathPull + 0.1);
    expect(d.mode).toBe('killcam');
    run(d, 1);
    expect(d.mode).toBe('play');
    expect(d.preview).toBe(false);
    d.startPreview('victory', 2);
    expect(d.skip()).toBe(true);
  });

  it('a real death during a preview is not a preview (it waits for the respawn)', () => {
    const d = new CameraDirector();
    d.startPreview('death', 1, byPlayer);
    d.died(byPlayer);
    expect(d.preview).toBe(false);
    run(d, 3);
    expect(d.mode).toBe('killcam');
    expect(d.skip()).toBe(false);
  });
});
