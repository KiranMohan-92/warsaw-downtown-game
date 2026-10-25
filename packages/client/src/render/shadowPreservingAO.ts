import { N8AOPostPass } from 'n8ao';

/**
 * AO runs after the shaded world pass. Its transparency masks hide most casters;
 * refreshing shadows there would replace the complete map with a partial one.
 * Keep the current map and defer any manual update until a normal scene render.
 */
export class ShadowPreservingAOPass extends N8AOPostPass {
  override render(...args: Parameters<N8AOPostPass['render']>): void {
    const shadow = args[0].shadowMap;
    const autoUpdate = shadow.autoUpdate;
    const needsUpdate = shadow.needsUpdate;
    shadow.autoUpdate = false;
    shadow.needsUpdate = false;
    try {
      super.render(...args);
    } finally {
      shadow.autoUpdate = autoUpdate;
      shadow.needsUpdate = needsUpdate;
    }
  }
}
