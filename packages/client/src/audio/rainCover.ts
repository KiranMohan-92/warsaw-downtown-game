/**
 * How the rain sounds where the listener stands (pure; `Audio.setRainCover` applies it). Out in the
 * open: the full, bright bed. Under cover the direct patter is gone, so the bed is muffled
 * (low-pass) and quieter in proportion to how enclosed the spot is, and a roof close overhead
 * drums (a band-passed layer whose level falls with the roof's height).
 */
export interface RainShelterLike {
  /** Height of the cover above the listener (m), Infinity in the open. */
  roof: number;
  /** Share of the surroundings open to the rain, 0..1. */
  open: number;
}

export interface RainCoverMix {
  /** Low-pass cutoff of the rain bed (Hz). */
  cutoff: number;
  /** Bed gain multiplier (1 = open air). */
  bed: number;
  /** Roof drumming layer, 0..1. */
  drum: number;
}

export function rainCoverMix(s: RainShelterLike): RainCoverMix {
  const open = Math.min(1, Math.max(0, s.open));
  if (!Number.isFinite(s.roof)) {
    // In the open: only nearby walls thin the bed a little.
    return { cutoff: 9000 + 9000 * open, bed: 0.75 + 0.25 * open, drum: 0 };
  }
  // Under cover: the louder and brighter the more of the surroundings is open (an awning vs the
  // metro), drumming when the roof is right overhead.
  const cutoff = 700 + 5300 * open * open;
  const bed = 0.25 + 0.65 * open;
  const drum = Math.exp(-Math.max(0, s.roof) / 3) * (0.4 + 0.6 * Math.sqrt(open));
  return { cutoff, bed, drum };
}
