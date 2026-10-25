import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARC, PRIMARIES, SHOTGUN, SIDEARM } from '@wd/shared';
import {
  cuesBetween,
  evalClip,
  inspectClip,
  pumpShotClip,
  RECOIL,
  reloadClip,
  SCAN_PRIMARY,
  ventClip,
  type Clip,
  type Cue,
} from './fpAnims.ts';
import { SCAN_GUN_IDS, type ScanGunId } from './viewGunScans.ts';

const guns = JSON.parse(
  readFileSync(new URL('../../public/models/guns/guns.json', import.meta.url), 'utf8'),
) as { guns: Record<string, { parts?: Record<string, unknown> }> };

const cueAt = (clip: Clip, cue: Cue): number => clip.cues.find((c) => c.cue === cue)?.t ?? NaN;
const cfg = (id: ScanGunId) => (id === 'pistol' ? SIDEARM : PRIMARIES[SCAN_PRIMARY[id]]);

describe('first-person clips', () => {
  it('has a tactical and an empty reload for every gun that reloads, timed to its tunables', () => {
    for (const id of SCAN_GUN_IDS) {
      const c = cfg(id);
      for (const empty of [false, true]) {
        const clip = reloadClip(id, empty);
        if (id === 'arc') {
          // Energy weapon: no magazine (reserve 0), so no reload — it vents instead.
          expect(clip).toBeNull();
          continue;
        }
        expect(clip, `${id} ${empty}`).not.toBeNull();
        expect(clip!.duration).toBe(empty ? c.reloadEmptyTime : c.reloadTime);
      }
    }
    expect(ARC.reserveAmmo).toBe(0);
  });

  it('seats the new magazine before the sim counts the rounds, and after the old one is out', () => {
    for (const id of ['rifle', 'iskra', 'marksman', 'pistol', 'coil'] as const) {
      for (const empty of [false, true]) {
        const clip = reloadClip(id, empty)!;
        const out = id === 'coil' ? cueAt(clip, 'cellOut') : cueAt(clip, 'magRelease');
        const seated = cueAt(clip, id === 'coil' ? 'cellIn' : 'magIn');
        expect(out, id).toBeGreaterThan(0);
        expect(seated, id).toBeGreaterThan(out);
        // The rounds arrive at reloadEnd (t = 1): the magazine is in well before it.
        expect(seated, id).toBeLessThan(0.9);
        if (empty) expect(clip.drop, id).toBeDefined(); // the empty one falls
      }
    }
  });

  it('racks the bolt (or releases the slide) only on the empty reload, after the new magazine', () => {
    for (const id of ['rifle', 'iskra', 'marksman'] as const) {
      expect(cueAt(reloadClip(id, false)!, 'boltForward')).toBeNaN();
      const e = reloadClip(id, true)!;
      expect(cueAt(e, 'boltForward')).toBeGreaterThan(cueAt(e, 'magIn'));
      expect(cueAt(e, 'boltForward')).toBeLessThan(1);
    }
    const p = reloadClip('pistol', true)!;
    expect(cueAt(p, 'slideRelease')).toBeGreaterThan(cueAt(p, 'magIn'));
    // The slide starts locked back on the empty reload and ends forward.
    expect(evalClip(p, 0).parts.slide!.a).toBeGreaterThan(0.015);
    expect(evalClip(p, 1).parts.slide!.a).toBe(0);
    expect(cueAt(reloadClip('pistol', false)!, 'slideRelease')).toBeNaN();
    // Shotgun from empty: shells, then the pump racks at the end.
    const s = reloadClip('shotgun', true)!;
    expect(s.cues.filter((c) => c.cue === 'shell').length).toBeGreaterThanOrEqual(3);
    expect(cueAt(s, 'pumpForward')).toBeGreaterThan(
      Math.max(...s.cues.filter((c) => c.cue === 'shell').map((c) => c.t)),
    );
  });

  it('starts and ends every clip at rest, with every channel on a part the scan really has', () => {
    for (const id of SCAN_GUN_IDS) {
      const parts = Object.keys(guns.guns[id]?.parts ?? {});
      const clips = [reloadClip(id, false), reloadClip(id, true), inspectClip(id)];
      if (id === 'shotgun') clips.push(pumpShotClip());
      if (id === 'arc') clips.push(ventClip(ARC.heat!.lockout));
      for (const clip of clips) {
        if (!clip) continue;
        for (const t of [0, 1]) {
          const pose = evalClip(clip, t);
          for (const v of pose.gun) expect(Math.abs(v), `${id} gun at ${t}`).toBeLessThan(1e-9);
          for (const [name, p] of Object.entries(pose.parts)) {
            if (name === 'slide' && t === 0) continue; // slide lock (checked above)
            expect(p.a, `${id}.${name} at ${t}`).toBe(0);
            expect(p.hide).toBe(false);
          }
          expect(pose.L?.space ?? 'bind').toBe('bind');
        }
        for (const name of Object.keys(clip.parts)) expect(parts, `${id}: ${name}`).toContain(name);
        for (const h of [...clip.L, ...clip.R])
          if (h.space !== 'bind' && h.space !== 'gun')
            expect(parts, `${id}: ${h.space}`).toContain(h.space);
        // Keys sorted within [0, 1].
        for (const keys of [clip.gun, clip.L, ...Object.values(clip.parts)])
          keys.forEach((k, i) => {
            expect(k.t).toBeGreaterThanOrEqual(0);
            expect(k.t).toBeLessThanOrEqual(1 + 1e-9);
            if (i) expect(k.t).toBeGreaterThanOrEqual(keys[i - 1]!.t);
          });
      }
    }
  });

  it('hides the old magazine only off-screen (while it is swapped for the fresh one)', () => {
    const clip = reloadClip('rifle', false)!;
    const hidden = Array.from({ length: 101 }, (_, i) => i / 100).filter(
      (t) => evalClip(clip, t).parts.mag!.hide,
    );
    expect(hidden.length).toBeGreaterThan(0);
    for (const t of hidden) expect(evalClip(clip, t).parts.mag!.a).toBeGreaterThan(0.1);
  });

  it('reports each cue once as progress passes it, never when scrubbing backwards', () => {
    const clip = reloadClip('rifle', true)!;
    const seen: Cue[] = [];
    for (let t = 0; t < 1; t += 1 / 150) seen.push(...cuesBetween(clip, t, t + 1 / 150));
    expect(seen).toEqual(clip.cues.map((c) => c.cue));
    expect(cuesBetween(clip, 0.9, 0.1)).toEqual([]);
  });

  it('racks the shotgun pump between shots, inside the fire interval', () => {
    expect(pumpShotClip().duration).toBeLessThan(60 / SHOTGUN.roundsPerMinute);
    const mid = evalClip(pumpShotClip(), 0.72);
    expect(mid.parts.pump!.a).toBeGreaterThan(0.05);
  });

  it('opens the ARC vent over the overheat lockout and closes it at the end', () => {
    const v = ventClip(ARC.heat!.lockout);
    expect(v.duration).toBeCloseTo(ARC.heat!.lockout, 6);
    expect(Math.abs(evalClip(v, 0.5).parts.vent!.r[2])).toBeGreaterThan(0.8);
    expect(evalClip(v, 1).parts.vent!.r[2]).toBe(0);
  });

  it('gives each gun its own recoil character', () => {
    expect(RECOIL.shotgun.climb).toBeGreaterThan(RECOIL.rifle.climb * 2);
    expect(RECOIL.coil.back).toBeGreaterThan(RECOIL.rifle.back * 2);
    expect(RECOIL.marksman.back).toBeGreaterThan(RECOIL.iskra.back * 3);
    expect(RECOIL.arc.back).toBeLessThan(RECOIL.iskra.back);
  });
});
