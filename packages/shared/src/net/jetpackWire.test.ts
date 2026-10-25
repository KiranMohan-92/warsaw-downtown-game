import { describe, expect, it } from 'vitest';
import { JETPACK } from '../config/tunables.ts';
import { grantJetpack, JetMode } from '../sim/jetpack.ts';
import { createPlayerState } from '../sim/player.ts';
import { SnapFlag } from './protocol.ts';
import { applySnapshotMove, snapshotError, toSnapshotPlayer } from './snapshot.ts';

describe('jetpack on the wire', () => {
  it('flags and own state round-trip; a missed pickup or ignition forces a correction', () => {
    const server = createPlayerState({ x: 1, y: 0, z: 2 });
    grantJetpack(server.move);
    const client = createPlayerState({ x: 1, y: 0, z: 2 });
    let snap = toSnapshotPlayer('me', server, 1, 0, { own: true });
    expect(snap.f & SnapFlag.Jetpack).toBeTruthy();
    expect(snap.own?.jp).toEqual([JetMode.Worn, JETPACK.flightTime]);
    expect(snapshotError(client, snap)).toBe(Infinity);
    applySnapshotMove(client, snap);
    expect(client.move.jet).toBe(JetMode.Worn);
    expect(client.move.jetFuel).toBe(JETPACK.flightTime);
    expect(snapshotError(client, snap)).toBeLessThan(1e-9);
    // The drop: our own entry carries the exact mode and fuel.
    server.move.jet = JetMode.Drop;
    server.move.jetFuel = 0;
    snap = toSnapshotPlayer('me', server, 2, 0, { own: true });
    expect(snap.f & SnapFlag.JetFlight).toBeTruthy();
    expect(snapshotError(client, snap)).toBe(Infinity);
    applySnapshotMove(client, snap);
    expect(client.move.jet).toBe(JetMode.Drop);
    // Others see flight + thrust from the bits.
    const other = createPlayerState({ x: 0, y: 0, z: 0 });
    server.move.jet = JetMode.Flying;
    server.move.jetThrust = true;
    applySnapshotMove(other, toSnapshotPlayer('them', server, 3, 0));
    expect(other.move.jet).toBe(JetMode.Flying);
    expect(other.move.jetThrust).toBe(true);
    // No pack: no bits, no own field; junk reads as none.
    const plain = toSnapshotPlayer('x', createPlayerState({ x: 0, y: 0, z: 0 }), 1, 0, {
      own: true,
    });
    expect(plain.f & (SnapFlag.Jetpack | SnapFlag.JetFlight | SnapFlag.JetThrust)).toBe(0);
    expect(plain.own?.jp).toBeUndefined();
    applySnapshotMove(client, { ...plain, own: { ...plain.own!, jp: [9, Number.NaN] } });
    expect(client.move.jet).toBe(JetMode.None);
  });

  it('others tell the unpowered drop from a hover (Codex P2: they serialized the same)', () => {
    const server = createPlayerState({ x: 0, y: 3, z: 0 });
    grantJetpack(server.move);
    server.move.jet = JetMode.Flying;
    const hover = toSnapshotPlayer('them', server, 1, 0);
    server.move.jet = JetMode.Drop;
    server.move.jetFuel = 0;
    const drop = toSnapshotPlayer('them', server, 2, 0);
    expect(hover.f).not.toBe(drop.f);
    expect(hover.f & SnapFlag.JetDrop).toBe(0);
    expect(drop.f & (SnapFlag.JetFlight | SnapFlag.JetDrop)).toBe(
      SnapFlag.JetFlight | SnapFlag.JetDrop,
    );
    const other = createPlayerState({ x: 0, y: 0, z: 0 });
    applySnapshotMove(other, drop);
    expect(other.move.jet).toBe(JetMode.Drop);
    applySnapshotMove(other, hover);
    expect(other.move.jet).toBe(JetMode.Flying);
    // A predicted drop the server still has flying (or the reverse) is a stance mismatch.
    const me = createPlayerState({ x: 0, y: 3, z: 0 });
    applySnapshotMove(me, drop);
    expect(snapshotError(me, hover)).toBe(Infinity);
  });

  it('takes bits 10-13, which no other flag uses', () => {
    const bits = Object.values(SnapFlag);
    expect(new Set(bits).size).toBe(bits.length);
    expect([SnapFlag.Jetpack, SnapFlag.JetFlight, SnapFlag.JetThrust, SnapFlag.JetDrop]).toEqual([
      1 << 10,
      1 << 11,
      1 << 12,
      1 << 13,
    ]);
  });
});
