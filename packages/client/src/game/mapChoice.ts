import { matchRadarToGameRadar, type FriendMatchSettings } from '../net/friendLobby.ts';
import type { Settings } from '../settings/settings.ts';

export type MapChoice = {
  map: Settings['map'];
  size: Settings['mapSize'];
  radar: Settings['radar'];
};

/**
 * The map this session builds: a friend room's, else the URL's (set on a map change, so it
 * survives a reload even when the browser blocks storage), else the settings'. All validated.
 */
export function resolveMapChoice(
  search: string,
  settings: Settings,
  friend: FriendMatchSettings | undefined,
): MapChoice {
  if (friend) {
    return { map: friend.map, size: friend.size, radar: matchRadarToGameRadar(friend.radar) };
  }
  const q = new URLSearchParams(search);
  const qm = q.get('map');
  const qs = q.get('size');
  const qr = q.get('radar');
  return {
    map: qm === 'defilad' || qm === 'range' ? qm : settings.map,
    size:
      qs === 'full' || qs === 'north' || qs === 'south' || qs === 'market' ? qs : settings.mapSize,
    radar: qr === 'off' || qr === 'pickups' ? qr : settings.radar,
  };
}
