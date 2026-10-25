import type { PhysicsWorld, Vec3 } from '@wd/shared';

/** Settled controller anchors on the current Market geometry, rather than a dated probe file. */
export function marketStairTestPoses(world: PhysicsWorld): { feet: Vec3 }[] {
  return [150.6, 150, 149, 148, 147, 146].map((x) => {
    const body = world.createCharacter({ x, y: 4.3, z: 26.7 });
    try {
      let grounded = false;
      for (let tick = 0; tick < 360; tick++)
        grounded = body.move({ x: 0, y: -0.05, z: 0 }).grounded;
      if (!grounded) throw new Error(`Market stair fixture did not settle at x=${x}`);
      return { feet: { ...body.position } };
    } finally {
      body.free();
    }
  });
}
