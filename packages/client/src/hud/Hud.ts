import * as THREE from 'three';
import type { HitZone, MatchMode, Slot, Vec3 } from '@wd/shared';

interface DamageNumber {
  el: HTMLDivElement;
  world: THREE.Vector3;
  life: number;
}

/**
 * DOM HUD. Crosshair gap is the true spread cone projected to pixels, so what the crosshair
 * shows is exactly where bullets can land.
 */
export class Hud {
  readonly root: HTMLDivElement;
  private readonly cross: HTMLDivElement;
  private readonly lines: HTMLDivElement[];
  private readonly dot: HTMLDivElement;
  private readonly redDot: HTMLDivElement;
  private readonly hit: HTMLDivElement;
  private readonly ammo: HTMLDivElement;
  private readonly reserve: HTMLSpanElement;
  private readonly weapon: HTMLDivElement;
  private readonly health: HTMLDivElement;
  private readonly healthFill: HTMLDivElement;
  private readonly reloadBar: HTMLDivElement;
  private readonly reloadFill: HTMLDivElement;
  private readonly healthBox: HTMLDivElement;
  private readonly healthLag: HTMLDivElement;
  private readonly ammoBox: HTMLDivElement;
  private readonly magTicks: HTMLDivElement;
  private readonly tickEls: HTMLSpanElement[] = [];
  private readonly statusProne: HTMLDivElement;
  private readonly statusBoard: HTMLDivElement;
  private readonly statusProtected: HTMLDivElement;
  private readonly protectedFill: HTMLElement;
  private readonly statusTac: HTMLDivElement;
  private readonly tacFill: HTMLElement;
  // Last values written to the DOM (the HUD is fed every frame; only changes touch the DOM).
  private ammoKey = '';
  private healthKey = '';
  private reloadKey = '';
  private statusKey = '';
  private readonly magSeen = new Map<string, number>();
  private readonly numbers: DamageNumber[] = [];
  private hitLife = 0;
  private readonly v = new THREE.Vector3();
  private readonly slots: HTMLDivElement;
  private readonly slotEls = new Map<Slot, HTMLDivElement>();
  private readonly grenadeEl: HTMLDivElement;
  private readonly vignette: HTMLDivElement;
  private readonly healVignette: HTMLDivElement;
  private healLife = 0;
  private readonly arrow: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly dropPrompt: HTMLDivElement;
  private dropPromptText: string | null = null;
  private damageLife = 0;
  private readonly tell: HTMLDivElement;
  private readonly tellChevrons: Record<'left' | 'right' | 'center', HTMLDivElement>;
  private readonly tellArrow: HTMLDivElement;
  private readonly guard: HTMLDivElement;
  private readonly guardPips: HTMLDivElement[] = [];
  private bannerLife = 0;
  private loadoutKey = '';
  private readonly equip: HTMLDivElement;
  private equipKey = '';
  private readonly droneFeed: HTMLDivElement;
  private readonly scope: HTMLDivElement;
  private readonly droneLabel: HTMLDivElement;
  private readonly droneHelp: HTMLDivElement;
  private readonly droneBattery: HTMLDivElement;
  private readonly spotMarks: HTMLDivElement[] = [];
  private readonly spotHost: HTMLDivElement;
  /** Cinematic camera moments: letterbox bars, the kill-cam card and the skip hint. */
  private readonly cine: HTMLDivElement;
  private readonly killCard: HTMLDivElement;
  private readonly killName: HTMLDivElement;
  private readonly killInfo: HTMLDivElement;
  private readonly cineHint: HTMLDivElement;
  private cineKey = '';
  private killKey = '';

  constructor(parent: HTMLElement) {
    const el = (cls: string, host: HTMLElement = this.root): HTMLDivElement => {
      const d = document.createElement('div');
      d.className = cls;
      host.append(d);
      return d;
    };
    this.root = document.createElement('div');
    this.root.className = 'hud-root';
    parent.append(this.root);
    this.dropPrompt = el('veh-prompt');
    this.dropPrompt.dataset.testid = 'weapon-drop-prompt';

    // Visor frame: thin corner brackets around the whole view.
    const frame = el('hud-frame');
    for (const c of ['tl', 'tr', 'bl', 'br']) el(`hud-corner hud-${c}`, frame);

    this.cross = el('crosshair');
    this.lines = ['t', 'b', 'l', 'r'].map((s) => el(`ch-line ch-${s}`, this.cross));
    this.dot = el('ch-dot', this.cross);
    this.redDot = el('red-dot');
    this.hit = el('hitmarker');
    for (const s of ['a', 'b', 'c', 'd']) el(`hm hm-${s}`, this.hit);

    const ammoBox = el('ammo-box');
    this.ammoBox = ammoBox;
    this.weapon = el('weapon-name', ammoBox);
    this.ammo = el('ammo', ammoBox);
    this.ammo.dataset.testid = 'ammo';
    this.reserve = document.createElement('span');
    this.reserve.className = 'reserve';
    // One tick per round in the magazine; spent rounds go dark.
    this.magTicks = el('mag-ticks', ammoBox);

    const hp = el('health-box');
    this.healthBox = hp;
    const hpHead = el('health-head', hp);
    el('health-label', hpHead).textContent = 'VITALS';
    this.health = el('health-num', hpHead);
    const bar = el('health-bar', hp);
    this.healthLag = el('health-lag', bar);
    this.healthFill = el('health-fill', bar);

    // Stance / status chips (above the health panel).
    const status = el('status-chips');
    this.statusProne = el('status-chip prone', status);
    this.statusProne.dataset.testid = 'status-prone';
    this.statusProne.textContent = 'PRONE';
    this.statusBoard = el('status-chip board', status);
    this.statusBoard.dataset.testid = 'status-board';
    this.statusBoard.textContent = 'BOARD';
    // Spawn protection: the chip with a bar that drains as it runs out.
    this.statusProtected = el('status-chip protected', status);
    this.statusProtected.dataset.testid = 'status-protected';
    this.statusProtected.textContent = 'PROTECTED';
    const drain = document.createElement('span');
    drain.className = 'chip-drain';
    this.protectedFill = document.createElement('i');
    drain.append(this.protectedFill);
    this.statusProtected.append(drain);
    // Tactical sprint: lit while bursting, dim while the tank refills; the bar is the tank.
    this.statusTac = el('status-chip protected tac', status);
    this.statusTac.dataset.testid = 'status-tac';
    this.statusTac.textContent = 'TAC SPRINT';
    const tank = document.createElement('span');
    tank.className = 'chip-drain';
    this.tacFill = document.createElement('i');
    tank.append(this.tacFill);
    this.statusTac.append(tank);

    this.reloadBar = el('reload-bar');
    this.reloadFill = el('reload-fill', this.reloadBar);

    // Weapon slots (1/2/3) + grenade count, above the ammo readout.
    this.slots = el('slots');
    this.slots.dataset.testid = 'slots';
    const names: [Slot, string, string][] = [
      ['rifle', '1', 'Rifle'],
      ['sidearm', '2', 'Pistol'],
      ['knife', '3', 'Knife'],
    ];
    for (const [slot, key, label] of names) {
      const d = el('slot', this.slots);
      d.innerHTML = `<kbd>${key}</kbd><span>${label}</span>`;
      this.slotEls.set(slot, d);
    }
    this.grenadeEl = el('slot grenade', this.slots);
    this.equip = el('equip');
    this.equip.dataset.testid = 'equipment';
    // Recon-drone camera feed (scanlines, battery, how to return).
    // Marksman scope (coilgun fully aimed): a full-screen reticle instead of the gun model.
    this.scope = el('scope');
    this.scope.dataset.testid = 'scope';
    el('scope-reticle', this.scope);
    this.root.prepend(this.scope); // under every other HUD element (health, ammo stay readable)
    this.droneFeed = el('drone-feed');
    this.droneFeed.dataset.testid = 'drone-feed';
    this.droneLabel = el('drone-label', this.droneFeed);
    this.droneHelp = el('drone-help', this.droneFeed);
    const batt = el('drone-batt', this.droneFeed);
    this.droneBattery = el('drone-batt-fill', batt);
    this.spotHost = el('spot-host');

    // Knife tell: chevrons around the crosshair on the side the cut comes from.
    this.tell = el('tell');
    this.tell.dataset.testid = 'knife-tell';
    this.tellChevrons = {
      left: el('tell-chev tell-left', this.tell),
      right: el('tell-chev tell-right', this.tell),
      center: el('tell-chev tell-center', this.tell),
    };
    this.tellArrow = el('tell-arrow');
    // Guard meter (pips = strikes the guard can still absorb).
    this.guard = el('guard');
    this.guard.dataset.testid = 'guard';
    for (let i = 0; i < 3; i++) this.guardPips.push(el('guard-pip', this.guard));

    this.vignette = el('dmg-vignette');
    this.healVignette = el('heal-vignette');
    this.arrow = el('dmg-arrow');
    this.bannerEl = el('banner');

    this.cine = el('cine-layer');
    this.cine.dataset.testid = 'cinematic';
    el('cine-bar cine-top', this.cine);
    el('cine-bar cine-bottom', this.cine);
    this.killCard = el('killcam', this.cine);
    this.killCard.dataset.testid = 'killcam';
    el('killcam-tag', this.killCard).textContent = 'KILL CAM';
    this.killName = el('killcam-name', this.killCard);
    this.killInfo = el('killcam-info', this.killCard);
    this.cineHint = el('cine-hint', this.cine);
  }

  /**
   * A camera moment is on screen (`mode`, or null for first person): letterbox bars, and the
   * gameplay readouts (crosshair, ammo, slots…) hide — the host's `cine` class does that in CSS
   * (the radar lives beside the HUD root). `hint` is the skip prompt ('' = none).
   */
  setCinematic(mode: string | null, hint = ''): void {
    const key = `${mode ?? ''}|${hint}`;
    if (key === this.cineKey) return;
    this.cineKey = key;
    this.cine.classList.toggle('show', mode !== null);
    this.cine.dataset.mode = mode ?? '';
    this.root.parentElement?.classList.toggle('cine-on', mode !== null);
    this.cineHint.textContent = hint;
  }

  /** The kill-cam card: who, with what, how far, headshot. Null hides it. */
  setKillCam(
    info: { killerName: string; weapon: string; distance: number; headshot: boolean } | null,
  ): void {
    const key = info
      ? `${info.killerName}|${info.weapon}|${Math.round(info.distance)}|${info.headshot}`
      : '';
    if (key === this.killKey) return;
    this.killKey = key;
    this.killCard.classList.toggle('show', info !== null);
    if (!info) return;
    this.killName.textContent = info.killerName;
    this.killInfo.textContent = `${info.weapon} · ${Math.round(info.distance)} m${info.headshot ? ' · HEADSHOT' : ''}`;
    this.killCard.classList.toggle('headshot', info.headshot);
  }

  /** Slot bar: highlights the weapon in hand (or being raised); knife-only hides guns. */
  setLoadout(active: Slot, mode: MatchMode, grenades: number): void {
    const key = `${active}|${mode}|${grenades}`;
    if (key === this.loadoutKey) return;
    this.loadoutKey = key;
    for (const [slot, d] of this.slotEls) {
      d.classList.toggle('active', slot === active);
      d.style.display = mode === 'knife' && slot !== 'knife' ? 'none' : '';
    }
    this.grenadeEl.innerHTML = `<kbd>G</kbd><span>Frag ×${grenades}</span>`;
    this.grenadeEl.classList.toggle('empty', grenades === 0);
    this.grenadeEl.style.display = mode === 'knife' ? 'none' : '';
  }

  /** Tactical kit: smoke (H), jammer (J), drone charge (B) — with their current keys. */
  setEquipment(
    smokes: number,
    jammers: number,
    drones: number,
    keys: { smoke: string; jammer: string; drone: string },
  ): void {
    const key = `${smokes}|${jammers}|${drones}|${keys.smoke}${keys.jammer}${keys.drone}`;
    if (key === this.equipKey) return;
    this.equipKey = key;
    const item = (k: string, label: string, n: number): string =>
      `<span class="eq${n > 0 ? '' : ' empty'}"><kbd>${k}</kbd>${label} ×${n}</span>`;
    this.equip.innerHTML =
      item(keys.smoke, 'Smoke', smokes) +
      item(keys.jammer, 'Jammer', jammers) +
      item(keys.drone, 'Drone', drones);
  }

  /** Recon-drone feed overlay while piloting (null = off). */
  /** Scope overlay on/off (the viewmodel hides while it's up). */
  setScope(on: boolean): void {
    this.scope.classList.toggle('show', on);
  }

  setDrone(
    state: {
      battery: number;
      max: number;
      recallKey: string;
      upKey: string;
      downKey: string;
    } | null,
  ): void {
    this.droneFeed.classList.toggle('show', state !== null);
    this.cross.style.visibility = state ? 'hidden' : '';
    if (!state) return;
    this.droneLabel.textContent = `RECON DRONE · ${Math.ceil(state.battery)} s · ${state.recallKey} to return`;
    this.droneHelp.textContent = `WASD + look to fly · ${state.upKey} up · ${state.downKey} down`;
    this.droneBattery.style.width = `${Math.max(0, (state.battery / state.max) * 100)}%`;
  }

  /** Brackets on spotted players (screen positions in CSS px; empty = none). */
  setSpotMarks(points: readonly { x: number; y: number }[]): void {
    while (this.spotMarks.length < points.length) {
      const d = document.createElement('div');
      d.className = 'spot-mark';
      this.spotHost.append(d);
      this.spotMarks.push(d);
    }
    this.spotMarks.forEach((d, i) => {
      const p = points[i];
      d.style.display = p ? '' : 'none';
      if (p) d.style.transform = `translate(${p.x - 14}px, ${p.y - 14}px)`;
    });
  }

  /** Cyan edge flash: a medkit healed you. */
  heal(): void {
    this.healLife = 1;
  }

  /** Red edge flash plus an arrow pointing toward the damage source. */
  damage(fraction: number, from: Vec3, camera: THREE.Camera): void {
    this.damageLife = Math.min(1, 0.35 + fraction * 2);
    const local = this.v.set(from.x, from.y, from.z).applyMatrix4(camera.matrixWorldInverse);
    const angle = Math.atan2(local.x, -local.z); // 0 = ahead, clockwise positive
    this.arrow.style.transform = `translate(-50%, -50%) rotate(${angle}rad) translateY(-120px)`;
  }

  /**
   * Incoming knife strike tell. `side` is the line of the cut from the defender's view; `progress`
   * 0 → 1 as impact approaches; `bearing` (radians, 0 = straight ahead, + = to the right) points an
   * edge arrow when the attacker is outside the view.
   */
  knifeTell(
    show: boolean,
    side: 'left' | 'right' | 'center' = 'center',
    progress = 0,
    bearing = 0,
  ): void {
    this.tell.classList.toggle('show', show);
    if (!show) {
      this.tellArrow.style.opacity = '0';
      return;
    }
    for (const [k, chev] of Object.entries(this.tellChevrons)) {
      const active = k === side;
      chev.classList.toggle('active', active);
      chev.style.setProperty('--p', active ? String(progress) : '0');
    }
    const offscreen = Math.abs(bearing) > 0.6;
    this.tellArrow.style.opacity = offscreen ? '1' : '0';
    this.tellArrow.style.transform = `translate(-50%, -50%) rotate(${bearing}rad) translateY(-150px)`;
  }

  /** Guard meter: shown while guarding; `left` pips remain; `broken` greys it out. */
  setGuard(visible: boolean, left: number, broken: boolean): void {
    this.guard.classList.toggle('show', visible || broken);
    this.guard.classList.toggle('broken', broken);
    this.guardPips.forEach((pip, i) => pip.classList.toggle('on', i < left));
  }

  banner(text: string, seconds = 2.5): void {
    this.bannerEl.textContent = text;
    this.bannerLife = seconds;
    // Replay the holographic "print-in" (banners are rare; the forced reflow is fine here).
    this.bannerEl.classList.remove('in');
    void this.bannerEl.offsetWidth;
    this.bannerEl.classList.add('in');
  }

  setDropPrompt(text: string | null): void {
    if (text === this.dropPromptText) return;
    this.dropPromptText = text;
    this.dropPrompt.classList.toggle('on', text !== null);
    this.dropPrompt.textContent = text ?? '';
  }

  /** Ends the banner early if it still shows a hint starting with `prefix` (its advice was taken). */
  dismissBanner(prefix: string): void {
    if (this.bannerLife > 0 && this.bannerEl.textContent?.startsWith(prefix))
      this.bannerLife = Math.min(this.bannerLife, 0.15);
  }

  /**
   * Status chips: PRONE while lying down, BOARD while riding the skateboard, PROTECTED while
   * spawn-protected (`protection` = the share left, 0..1; 0 hides it).
   */
  setStatus(s: {
    prone: boolean;
    board: boolean;
    protection?: number;
    /** Tactical sprint: bursting now, and the tank (0–1). */
    tac?: { on: boolean; fuel: number };
  }): void {
    // The drain bars move in 2 % steps: at most ~50 DOM writes over a whole protection / tank.
    const left = Math.round(Math.max(0, Math.min(1, s.protection ?? 0)) * 50);
    const tank = Math.round(Math.max(0, Math.min(1, s.tac?.fuel ?? 1)) * 50);
    const tacOn = s.tac?.on === true;
    const key = `${s.prone ? 1 : 0}${s.board ? 1 : 0}${left}|${tacOn ? 1 : 0}${tank}`;
    if (key === this.statusKey) return;
    this.statusKey = key;
    this.statusProne.classList.toggle('on', s.prone);
    this.statusBoard.classList.toggle('on', s.board);
    this.statusProtected.classList.toggle('on', left > 0);
    this.protectedFill.style.transform = `scaleX(${left / 50})`;
    this.statusTac.classList.toggle('on', tacOn || tank < 50);
    this.statusTac.classList.toggle('refill', !tacOn);
    this.tacFill.style.transform = `scaleX(${tank / 50})`;
  }

  setCrosshairColor(color: string): void {
    this.root.style.setProperty('--xhair', color);
  }

  /**
   * @param spreadDeg current spread cone half-angle
   * @param vfovDeg current vertical FOV, to convert angles to pixels
   */
  updateCrosshair(
    spreadDeg: number,
    vfovDeg: number,
    adsAmount: number,
    sprinting: boolean,
    opts: { knife: boolean; redDot: boolean } = { knife: false, redDot: true },
  ): void {
    const h = window.innerHeight;
    const px =
      (Math.tan((spreadDeg * Math.PI) / 180) / Math.tan((vfovDeg * Math.PI) / 360)) * (h / 2);
    const gap = Math.max(3, px);
    const [t, b, l, r] = this.lines as [
      HTMLDivElement,
      HTMLDivElement,
      HTMLDivElement,
      HTMLDivElement,
    ];
    t.style.transform = `translate(-50%, calc(-100% - ${gap}px))`;
    b.style.transform = `translate(-50%, ${gap}px)`;
    l.style.transform = `translate(calc(-100% - ${gap}px), -50%)`;
    r.style.transform = `translate(${gap}px, -50%)`;
    const hide = sprinting ? 0 : 1 - Math.min(1, adsAmount * 1.6);
    // Knife: centre dot only (no spread). Pistol ADS uses iron sights, rifle ADS the red dot.
    for (const line of this.lines) line.style.display = opts.knife ? 'none' : '';
    this.cross.style.opacity = String(hide);
    this.dot.style.opacity = String(opts.knife ? 1 : hide);
    this.redDot.style.opacity = opts.redDot ? String(Math.max(0, (adsAmount - 0.7) / 0.3)) : '0';
  }

  /**
   * ammo < 0 means a melee weapon (no ammo readout). `magazine` sizes the round-tick bar; when
   * omitted, the largest magazine seen for this weapon is used.
   */
  setAmmo(
    ammo: number,
    reserve: number,
    name: string,
    reloading: boolean,
    magazine?: number,
  ): void {
    const key = `${ammo}|${reserve}|${name}|${reloading ? 1 : 0}|${magazine ?? ''}`;
    if (key === this.ammoKey) return;
    this.ammoKey = key;
    this.weapon.textContent = name;
    if (ammo < 0) {
      this.ammo.textContent = '—';
      this.ammo.classList.remove('low');
      this.ammoBox.classList.add('melee');
      this.ammoBox.classList.remove('low', 'empty', 'heat', 'hot', 'overheated');
      return;
    }
    this.ammoBox.classList.remove('melee', 'heat', 'hot', 'overheated');
    this.ammo.textContent = String(ammo);
    this.reserve.textContent = ` / ${reserve}`;
    this.ammo.append(this.reserve);
    const mag = Math.max(ammo, magazine ?? 0, this.magSeen.get(name) ?? 0);
    this.magSeen.set(name, mag);
    const low = ammo <= Math.max(3, Math.ceil(mag * 0.25)) && !reloading;
    this.ammo.classList.toggle('low', low);
    this.ammoBox.classList.toggle('low', low && ammo > 0);
    this.ammoBox.classList.toggle('empty', ammo === 0 && !reloading);
    this.setTicks(ammo, mag);
  }

  /**
   * Energy weapons (no magazine): the readout is heat %, the tick bar fills as it heats; amber
   * past 75 %, red with OVERHEAT while the trigger is locked.
   */
  setHeat(heat: number, overheated: boolean, name: string): void {
    const pct = Math.round(heat * 100);
    const key = `heat|${pct}|${overheated ? 1 : 0}|${name}`;
    if (key === this.ammoKey) return;
    this.ammoKey = key;
    this.weapon.textContent = name;
    this.ammoBox.classList.remove('melee', 'low', 'empty');
    this.ammoBox.classList.add('heat');
    this.ammoBox.classList.toggle('hot', heat > 0.75 && !overheated);
    this.ammoBox.classList.toggle('overheated', overheated);
    this.ammo.textContent = `${pct}`;
    this.reserve.textContent = ' % HEAT';
    this.ammo.append(this.reserve);
    this.ammo.classList.toggle('low', overheated);
    // 20 ticks, lit up to the heat (drawn as "spent" beyond it).
    this.setTicks(Math.round(heat * 20), 20);
  }

  private setTicks(ammo: number, mag: number): void {
    const n = Math.min(60, mag);
    this.magTicks.style.setProperty('--n', String(n));
    while (this.tickEls.length < n) {
      const t = document.createElement('span');
      this.magTicks.append(t);
      this.tickEls.push(t);
    }
    this.tickEls.forEach((t, i) => {
      t.style.display = i < n ? '' : 'none';
      // Rounds leave from the right, as the readout counts down.
      t.classList.toggle('spent', i >= ammo);
    });
  }

  setHealth(hp: number, max: number): void {
    const shown = Math.max(0, Math.ceil(hp));
    const key = `${shown}|${max}`;
    if (key === this.healthKey) return;
    this.healthKey = key;
    const f = Math.max(0, Math.min(1, hp / max));
    this.health.textContent = String(shown);
    this.healthFill.style.transform = `scaleX(${f})`;
    this.healthLag.style.transform = `scaleX(${f})`;
    this.healthBox.classList.toggle('low', shown > 0 && shown < 30);
    this.healthBox.classList.toggle('mid', shown >= 30 && shown < 60);
  }

  /** @param progress 0..1, or <0 to hide */
  setReload(progress: number): void {
    const key = progress >= 0 ? progress.toFixed(3) : 'off';
    if (key === this.reloadKey) return;
    this.reloadKey = key;
    this.reloadBar.style.opacity = progress >= 0 ? '1' : '0';
    this.reloadFill.style.transform = `scaleX(${Math.max(0, progress)})`;
  }

  hitmarker(zone: HitZone, killed: boolean): void {
    this.hit.classList.remove('head', 'kill', 'show', 'blocked');
    void this.hit.offsetWidth; // restart the CSS animation
    if (zone === 'head') this.hit.classList.add('head');
    if (killed) this.hit.classList.add('kill');
    this.hit.classList.add('show');
    this.hitLife = killed ? 0.35 : 0.18;
  }

  /**
   * A hit on a spawn-protected player: nothing landed, so a distinct marker (cyan ticks pushed
   * out around a shield ring) and never a damage number.
   */
  blockedMarker(): void {
    this.hit.classList.remove('head', 'kill', 'show', 'blocked');
    void this.hit.offsetWidth; // restart the CSS animation
    this.hit.classList.add('blocked', 'show');
    this.hitLife = 0.22;
  }

  damageNumber(world: Vec3, amount: number, zone: HitZone): void {
    const e = document.createElement('div');
    e.className = `dmg-num${zone === 'head' ? ' head' : ''}`;
    e.textContent = String(Math.round(amount));
    this.root.append(e);
    this.numbers.push({
      el: e,
      world: new THREE.Vector3(world.x + (Math.random() - 0.5) * 0.2, world.y, world.z),
      life: 0.8,
    });
  }

  update(dt: number, camera: THREE.Camera): void {
    // Fades write the DOM only while they run (and once more to land on 0).
    if (this.damageLife > 0 || this.vignette.style.opacity !== '0') {
      this.damageLife = Math.max(0, this.damageLife - dt * 1.2);
      this.vignette.style.opacity = String(this.damageLife);
      this.arrow.style.opacity = String(Math.min(1, this.damageLife * 1.5));
    }
    if (this.healLife > 0 || this.healVignette.style.opacity !== '0') {
      this.healLife = Math.max(0, this.healLife - dt * 1.4);
      this.healVignette.style.opacity = String(this.healLife * 0.8);
    }
    if (this.bannerLife > 0 || this.bannerEl.style.opacity !== '0') {
      this.bannerLife = Math.max(0, this.bannerLife - dt);
      this.bannerEl.style.opacity = String(Math.min(1, this.bannerLife * 2));
    }
    this.hitLife -= dt;
    if (this.hitLife <= 0) this.hit.classList.remove('show');
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i]!;
      n.life -= dt;
      n.world.y += dt * 0.6;
      this.v.copy(n.world).project(camera);
      const visible = n.life > 0 && this.v.z < 1;
      if (!visible) {
        if (n.life <= 0) {
          n.el.remove();
          this.numbers.splice(i, 1);
        } else n.el.style.opacity = '0';
        continue;
      }
      n.el.style.opacity = String(Math.min(1, n.life / 0.3));
      n.el.style.transform = `translate(${(this.v.x * 0.5 + 0.5) * window.innerWidth}px, ${(-this.v.y * 0.5 + 0.5) * window.innerHeight}px) translate(-50%, -50%)`;
    }
  }
}
