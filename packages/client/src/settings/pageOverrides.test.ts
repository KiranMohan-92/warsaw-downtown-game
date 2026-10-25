import { describe, expect, it } from 'vitest';
import { PageOverrides } from './pageOverrides.ts';
import { DEFAULT_SETTINGS, type Settings } from './settings.ts';

/** The player's own saved settings (not the defaults, so a leak is visible). */
const own = (): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  online: false,
  map: 'range',
  mapSize: 'full',
  radar: 'off',
  weather: 'dusk',
  matchMode: 'standard',
});

/**
 * A friend room forces its host's match settings (as Game's constructor does). The room's
 * values are the defaults, so a reset or a re-selection writes the same values it forced.
 */
function friendRoom(s: Settings): PageOverrides {
  const o = new PageOverrides();
  o.force(s, 'online', true);
  o.force(s, 'map', DEFAULT_SETTINGS.map);
  o.force(s, 'mapSize', DEFAULT_SETTINGS.mapSize);
  o.force(s, 'radar', DEFAULT_SETTINGS.radar);
  o.force(s, 'weather', DEFAULT_SETTINGS.weather);
  o.force(s, 'matchMode', 'knife');
  return o;
}

describe('PageOverrides: friend-room settings are never saved as the player’s (review fix)', () => {
  it('an unrelated menu change after a friend room keeps the saved map/size/radar/weather', () => {
    const s = own();
    const o = friendRoom(s);
    // The page runs (and the menu shows) the room's settings …
    expect([s.online, s.map, s.mapSize, s.radar, s.weather, s.matchMode]).toEqual([
      true,
      DEFAULT_SETTINGS.map,
      DEFAULT_SETTINGS.mapSize,
      DEFAULT_SETTINGS.radar,
      DEFAULT_SETTINGS.weather,
      'knife',
    ]);
    // … the player changes only the sensitivity: everything else saves as it was.
    s.sensitivity = 2.5;
    expect(o.toSave(s, ['sensitivity'])).toEqual({ ...own(), sensitivity: 2.5 });
    // Saving never changes what the page runs.
    expect(s.weather).toBe(DEFAULT_SETTINGS.weather);
  });

  it('a setting the player changes on that page is saved (and stays theirs)', () => {
    const s = own();
    const o = friendRoom(s);
    s.weather = 'overcast';
    expect(o.toSave(s, ['weather'])).toMatchObject({ weather: 'overcast', map: 'range' });
    // Later host updates move only the shown value; the player's own stays saved.
    o.force(s, 'map', 'defilad');
    o.force(s, 'weather', 'rain');
    expect(o.toSave(s, ['fov'])).toMatchObject({ map: 'range', weather: 'overcast' });
  });

  it('"Reset all settings" saves the defaults, even where they equal the forced values', () => {
    const s = own();
    const o = friendRoom(s);
    Object.assign(s, structuredClone(DEFAULT_SETTINGS));
    expect(o.toSave(s, 'all')).toEqual(DEFAULT_SETTINGS);
    // The reset values are the player's own from then on.
    s.fov = 100;
    expect(o.toSave(s, ['fov'])).toEqual({ ...DEFAULT_SETTINGS, fov: 100 });
  });

  it('explicitly selecting the forced value saves it', () => {
    const s = own();
    const o = friendRoom(s);
    // The menu already shows the room's weather; the player picks it anyway.
    s.weather = DEFAULT_SETTINGS.weather;
    expect(o.toSave(s, ['weather'])).toMatchObject({ weather: DEFAULT_SETTINGS.weather });
    // Online too: ticking the box the room already ticked is a real choice.
    expect(o.toSave(s, ['online'])).toMatchObject({ online: true, map: 'range' });
  });

  it('with nothing forced, saves the menu as is', () => {
    const s = own();
    s.map = 'defilad';
    expect(new PageOverrides().toSave(s, ['map'])).toEqual(s);
  });
});
