import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceTreeView, treeReductionChecks } from './treeBakeReduction.mjs';

test('synthetic bake regressions cover coverage, linear light, normals and row orientation', () => {
  assert.equal(treeReductionChecks().length, 8);
});

test('normal averaging uses colour coverage, independently of packed AO alpha', () => {
  const color = new Uint8Array([50, 90, 30, 255, 50, 90, 30, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  const normals = new Uint8Array([
    255, 128, 128, 1, 128, 255, 128, 255, 0, 0, 255, 255, 0, 0, 255, 255,
  ]);
  const ao = new Uint8Array([180, 180, 180, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const reduced = reduceTreeView(color, normals, ao, 2, 2);
  assert.equal(reduced.normals[0], reduced.normals[1]);
  assert.ok(Math.abs(reduced.normals[2] - 128) <= 1);
  assert.equal(reduced.normals[3], 218);
  assert.equal(reduced.color[3], 128);
});

test('empty regions stay transparent and AO remains bounded independently of coverage', () => {
  const color = new Uint8Array(4 * 4 * 4);
  const normal = new Uint8Array(color.length).fill(255);
  const ao = new Uint8Array(color.length);
  color.set([50, 90, 30, 255]);
  const reduced = reduceTreeView(color, normal, ao, 4, 2);
  for (let i = 3; i < reduced.color.length; i += 4) {
    if (reduced.color[i] === 0) assert.equal(reduced.normals[i], 255);
    else assert.equal(reduced.normals[i], Math.round(0.65 * 255));
  }
  assert.throws(() => reduceTreeView(color, normal.subarray(4), ao, 4, 2), /dimensions/);
});
