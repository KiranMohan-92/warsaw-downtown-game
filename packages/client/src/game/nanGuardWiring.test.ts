import * as THREE from 'three';
import { expect, it } from 'vitest';
// Only Game.ts is imported here: it alone must install the guard (its side-effect import).
import './Game.ts';

it('the game bundle installs the NaN guard before any shader compiles', () => {
  expect(THREE.ShaderChunk.dithering_fragment).toContain('wd:nan-guard');
});
