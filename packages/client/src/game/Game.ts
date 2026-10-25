import * as THREE from 'three';
import '../render/nanGuard.ts'; // before any shader compiles
import type { MatchRoomLink } from '../net/roomLink.ts';
import {
  BOT,
  Button,
  pressed,
  clearDropOwner,
  createWeaponDrops,
  observeDropOwners,
  spawnDrop,
  spawnDeathDrop,
  stepDrops,
  swapWithDrop,
  type WeaponDropEvent,
  type WeaponDropState,
  chooseSeat,
  inFireArc,
  sameCrew,
  seatFromWire,
  VEHICLE,
  withHulls,
  type SeatId,
  type SeatState,
  type VehicleMotion,
  clonePlayerState,
  computeDamage,
  createDummies,
  createPlayerState,
  currentSpread,
  weaponContext,
  damageDummy,
  explosionDamage,
  GRENADE,
  gunConfig,
  heldGun,
  applyKnifeStrike,
  humanoidHitboxes,
  isGun,
  KNIFE,
  strikeDamage,
  type HitTarget,
  type KnifeMove,
  resolveMelee,
  spawnGrenade,
  stepGrenade,
  type GrenadeState,
  DEG,
  dummyTargets,
  eyePosition,
  FEEL,
  horizontalSpeed,
  initPhysics,
  MOVEMENT,
  PhysicsWorld,
  PLAYER,
  SIM,
  SIM_DT,
  type HitZone,
  type PropPose,
  type SurfaceKind,
  type Vec3,
  surfaceOfModel,
  stepDummies,
  stepPlayerInCrowd,
  crowdHeight,
  crowdMemberOf,
  type CrowdMember,
  createPickups,
  createTactical,
  DRONE,
  droneSpots,
  grantPickup,
  JAMMER,
  jammerPulse,
  FoliageIndex,
  SIGHT_THRESHOLD,
  sightVisibility,
  markSpotted,
  radarView,
  stepRadar,
  stepSmoke,
  stepTactical,
  takesPickup,
  type SmokeCloud,
  type TacticalState,
  RADAR,
  stepPickups,
  healWithMedkit,
  matchPickupDefs,
  placeBodyAt,
  type PickupKind,
  boardSpawn,
  createBoard,
  stepBoard,
  type BoardState,
  createJetpacks,
  grantJetpack,
  jetpackRespawned,
  stepJetpacks,
  type JetpackItem,
  type MoveState,
  type PickupState,
  getMap,
  resolveMap,
  spawnsFor,
  type MapDefinition,
  type SpawnPoint,
  traceGunShot,
  sanitizeInput,
  normalizeMatchOptions,
  type LoadoutMessage,
  type PrimaryId,
  type ReadyMessage,
  type DummyState,
  type PlayerEvent,
  type PlayerState,
  type RapierCharacter,
  type ShotFired,
  type WelcomeMessage,
  type CombatEvent,
  MATCH,
  grantSpawnProtection,
  isSpawnProtected,
  pickSafeSpawn,
  snapshotProtected,
  SPAWN_PROTECTION,
  MATCH_NET,
  PRIMARIES,
  SIDEARM,
  SNAP_SLOTS,
  SnapFlag,
  playerAction,
} from '@wd/shared';
import { Audio } from '../audio/Audio.ts';
import { PerfOverlay } from '../debug/PerfOverlay.ts';
import { trackShadowGeometry, type ShadowGeometryStats } from '../debug/geometryStats.ts';
import { Spring } from '../feel/spring.ts';
import { Hud } from '../hud/Hud.ts';
import { Scoreboard, type ScoreboardPlayer, type ScoreboardView } from '../hud/Scoreboard.ts';
import { practiceChanges, practiceRestartUrl, practiceUrl } from '../net/practiceRoom.ts';
import { resolveMapChoice } from './mapChoice.ts';
import { Input } from '../input/Input.ts';
import { DummyView } from '../render/dummyView.ts';
import { ActorContactShadows } from '../render/actorContactShadows.ts';
import { applyLampVolume, updateLampProbe } from '../render/lampLight.ts';
import { Effects, type ExplosionContact } from '../render/effects.ts';
import { BlastAudioQueue } from '../audio/BlastAudioQueue.ts';
import { RemoteShotAudioQueue } from '../audio/RemoteShotAudioQueue.ts';
import { DynamicResolution, isLightFrame, RefreshEstimate } from '../render/dynamicResolution.ts';
import { GpuFrameTimer } from '../render/gpuTimer.ts';
import { PartnerView } from '../render/partnerView.ts';
import { PickupView } from '../render/pickupView.ts';
import { WeaponDropView } from '../render/weaponDropView.ts';
import { weaponDropPrompt } from '../hud/weaponDropPrompt.ts';
import { JammerFx, SmokeView } from '../render/tacticalFx.ts';
import { Radar } from '../hud/Radar.ts';
import { SparringPartner } from './Sparring.ts';
import {
  connectOnline,
  nameSender,
  OnlineJoin,
  OnlineLink,
  pageOnline,
  resolveServerUrl,
  wireOnlineRoom,
} from '../net/connectOnline.ts';
import { deathBanner, killLine, matchGoal, resultText } from '../net/combatFeed.ts';
import { OnlineBadge } from '../net/onlineBadge.ts';
import { OnlineSession, type RemoteDrone } from '../net/onlineSession.ts';
import { CorrectionSmoother } from '../net/correctionSmoother.ts';
import { GpuHint, isIntegratedGpu, webglRendererName } from '../hud/gpuHint.ts';
import { RemotePlayersView, SLOT_COLORS } from '../render/remotePlayersView.ts';
import { DroneView } from '../render/droneView.ts';
import { ChatController } from '../ui/ChatController.ts';
import {
  matchRadarToGameRadar,
  type FriendMatchSettings,
  type FriendRoomBuffer,
} from '../net/friendLobby.ts';

/** Only the opening strike's longer chamber is telegraphed (follow-ups and counters are fast). */
const isOpeningWindup = (windupTotal: number): boolean => windupTotal > KNIFE.windup + 1e-6;
import { EnvironmentLibrary } from '../render/environment.ts';
import {
  bakedLightingReady,
  buildMapMeshes,
  setBakedLighting,
  showAllLodLevels,
} from '../render/mapMesh.ts';
import { setGroundDetailMap } from '../render/groundDetail.ts';
import { buildSetDressing, updateSetDressing } from '../render/setDressing.ts';
import { showProduceDetailForWarmup } from '../render/marketProduce.ts';
import {
  buildMarketDistrictDetail,
  marketDetailDecalLift,
  updateMarketDistrictDetail,
} from '../render/marketDistrictDetail.ts';
import {
  loadHeroModel,
  buildHeroMeshes,
  loadHeroModels,
  updateHeroes,
} from '../render/heroModels.ts';
import {
  buildTreeMeshes,
  loadTreeModels,
  setTreeFade,
  treeFade,
  updateTrees,
} from '../render/treeModels.ts';
import {
  heldWeapon,
  loadGunScans,
  thirdPersonModels,
  gunScanLoadStats,
} from '../render/viewGunScans.ts';
import { loadKnifeArms, loadKnifeModel } from '../render/knifeModel.ts';
import { loadSoldiers, Soldier, type SoldierPose } from '../render/soldiers.ts';
import { aimBoard, buildSkateboard } from '../render/skateboard.ts';
import {
  groundBelowAt,
  jetFlyersOf,
  JetpackPresenter,
  type JetFlyer,
} from '../jetpack/JetpackPresenter.ts';
import { loadJetpackModel } from '../jetpack/jetpackModel.ts';
import { findFacadeDetail, type FacadeDetail } from '../render/facadeDetail.ts';
import {
  loadCanopyScan,
  setFoliageQuality,
  updateFoliage,
  foliageWind,
  setFoliageGust,
  warmFoliage,
  windStrengthFor,
} from '../render/foliageMesh.ts';
import { WindGusts, WindMotes } from '../render/wind.ts';
import { setRenderBudget } from '../render/renderBudget.ts';
import { MapMaterials } from '../render/materials.ts';
import { mapStageLabel, type BootSink } from '../loading/progress.ts';
import { installPropModels, loadPropModels, type PropDetail } from '../render/propModels.ts';
import { PostPipeline, type ResolvedQuality } from '../render/post.ts';
import { Rain } from '../render/rain.ts';
import { currentRainOcclusion, rainShelter, setRainOcclusionMap } from '../render/rainOcclusion.ts';
import { SkyDome } from '../render/sky.ts';
import { Viewmodel } from '../render/viewmodel.ts';
import { CameraDirector, CINE, type KillInfo } from '../camera/cameraDirector.ts';
import {
  blankSubject,
  CinematicCamera,
  MARKET_INTRO,
  type IntroKey,
  type ShotInputs,
  type ShotSubject,
} from '../camera/cinematicCamera.ts';
import { blankPose, ReplayRecorder } from '../camera/poseRing.ts';
import { collideCamera, CollisionSmoother, wideVantage } from '../camera/cinematicMath.ts';
import {
  CHASE_FRAMINGS,
  crownClear,
  crownOf,
  crownsNear,
  FramingSmoother,
  framingPoint,
  pickFraming,
  type Crown,
} from '../vehicles/chaseCamera.ts';
import { VehiclesView, type DrawnVehicle } from '../vehicles/vehiclesView.ts';
import { createFlatLift } from '../render/flatLift.ts';
import { FRONT_LAUNCH, TyreDemoRun, frontStart, type TyreDemoState } from '../vehicles/tyreDemo.ts';
import { VehicleHud, SEAT_LABEL } from '../vehicles/vehicleHud.ts';
import {
  hullsOf,
  seatEyeOf,
  withOwnTruck,
  withTrucks,
  type VehiclePose,
} from '../net/vehicleTrack.ts';
import type { RemotePose } from '../net/interpolation.ts';
import type { RemotePlayer } from '../net/onlineSession.ts';
import { WEATHER_PRESETS, WeatherSystem } from '../render/weather.ts';
import { NeonDistrict } from '../render/neonDistrict.ts';
import { loadCourtyardBake, setCourtyardBakeMap } from '../render/courtyardBake.ts';
import { loadMarketNeonBake, setMarketNeonBakeMap } from '../render/marketNeonBake.ts';
import {
  loadMarketNeonStaticBake,
  setMarketNeonStaticBakeMap,
} from '../render/marketNeonStaticBake.ts';
import { MARKET_NEON_BAKE } from '../render/marketNeonBakeManifest.ts';
import { loadPalaceColumnTextures } from '../render/palaceColumnMaterial.ts';
import {
  keyLabel,
  loadSettings,
  saveSettings,
  verticalFov,
  type Quality,
  type Settings,
  type WeatherId,
} from '../settings/settings.ts';
import { PageOverrides } from '../settings/pageOverrides.ts';
import { Menu } from '../ui/Menu.ts';

/** A stable voice (0-3) per player id: everyone keeps their own grunts and cries. */
export function voiceFor(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 4;
}

const QUALITY_STEPS: ResolvedQuality[] = ['low', 'medium', 'high', 'ultra'];

/**
 * The tiers warm-up draws everything through the real pipeline at, in order, ending on the start
 * tier. compileAsync alone leaves ANGLE/D3D11 to finish a program on its first real draw (three's
 * first-use `getProgramInfoLog`), so under Auto every tier the governor can step *down* to is
 * drawn too: starting at High with no remembered tier, the first knife/board soldier seen after
 * the drop to Low stalled 40–50 ms (Intel UHD). A fixed tier, or Auto already at Low, draws once.
 */
export function warmDrawTiers(setting: Quality | null, start: ResolvedQuality): ResolvedQuality[] {
  if (setting !== 'auto') return [start];
  const below = QUALITY_STEPS.slice(0, Math.max(0, QUALITY_STEPS.indexOf(start)));
  return [...below.reverse(), start];
}

/** Hit-target ids of other online players (prediction only), next to dummy ids. */
const REMOTE = 'remote:';
const REMOTE_DRONE = 'remote-drone:';

/** The marker an own online shot's prediction showed: a hit, blocked (spawn protection), none. */
type PredictedMarker = 'hit' | 'blocked' | null;

/** The share of spawn protection left (0..1), for the HUD chip's bar; 0 when not protected. */
export function protectionShare(p: PlayerState): number {
  return isSpawnProtected(p) ? Math.min(1, p.spawnGuard / SPAWN_PROTECTION.duration) : 0;
}

type BracketTarget = { id: string; pos: Vec3 };

export function spottedBracketWorldPoints(
  live: readonly BracketTarget[],
  spottedIds: ReadonlySet<string>,
  spottedFromServer: readonly BracketTarget[] | null,
): Vec3[] {
  const authoritativeSpots = spottedFromServer !== null;
  const source = spottedFromServer ?? live.filter((o) => spottedIds.has(o.id));
  return source.map((o) => ({
    x: o.pos.x,
    y: authoritativeSpots ? o.pos.y : o.pos.y + 1.2,
    z: o.pos.z,
  }));
}

const MAX_ONLINE_SHOT_MARKERS = 128;
/** Auto quality starts here and only steps down (with dynamic resolution absorbing load first). */
const AUTO_START: ResolvedQuality = 'high';

/** Where Auto quality settled on this machine last time (tier + resolution). */
const PERF_KEY = 'wd.perf.v1';
function loadPerfMemory(): { quality: ResolvedQuality; scale: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(PERF_KEY) ?? 'null') as {
      quality?: unknown;
      scale?: unknown;
    } | null;
    const q = raw?.quality;
    const sc = raw?.scale;
    if (
      (q === 'low' || q === 'medium' || q === 'high' || q === 'ultra') &&
      typeof sc === 'number' &&
      sc >= 0.5 &&
      sc <= 1
    ) {
      return { quality: q, scale: sc };
    }
  } catch {
    // storage blocked or corrupt: converge from scratch
  }
  return null;
}
function savePerfMemory(quality: ResolvedQuality, scale: number): void {
  try {
    localStorage.setItem(PERF_KEY, JSON.stringify({ quality, scale }));
  } catch {
    // storage blocked: fine, we'll converge again next time
  }
}
/** Shadow map size and coverage (half-extent, m) per quality. */
const SHADOWS: Record<ResolvedQuality, { size: number; half: number }> = {
  low: { size: 512, half: 28 },
  medium: { size: 1024, half: 36 },
  high: { size: 2048, half: 40 },
  ultra: { size: 4096, half: 48 },
};
const lerp = THREE.MathUtils.lerp;

export interface GameOptions {
  /** Scripted-input mode for automated tests: no pointer lock, window.__wd hook. */
  autotest: boolean;
  /** Run the frame-time governor even under autotest (perf probe). */
  governor?: boolean;
  /** A friend-room socket joined before the game was built, so map/weather are authoritative. */
  friendRoom?: MatchRoomLink;
  friendSettings?: FriendMatchSettings;
  friendBuffer?: FriendRoomBuffer;
  friendName?: string;
  /** The friend room is a local practice match vs bots (`net/practiceRoom.ts`). */
  practice?: boolean;
  /** Boot progress for the loading screen (stages reported by Game.create). */
  boot?: BootSink;
}

export class Game {
  readonly settings: Settings = loadSettings();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 600);
  private readonly sun = new THREE.DirectionalLight('#fff1dc', 2.6);
  private readonly hemi = new THREE.HemisphereLight('#dde8f5', '#5b5348', 0.4);
  private readonly sky: SkyDome;
  private readonly rain = new Rain();
  private readonly weather: WeatherSystem;
  private readonly neonDistrict: NeonDistrict;
  private readonly materials: MapMaterials;
  /** Facade relief (Palace + OSM blocks): per-cell level of detail picked every frame. */
  private readonly facade: FacadeDetail | null;
  /** Stall awnings, produce and food trucks (render/setDressing.ts). */
  private readonly dressing: THREE.Group;
  private readonly marketDistrictDetail: THREE.Group;
  /** Generated hero models (render/heroModels.ts), added once assets load. */
  private heroes: THREE.Group | null = null;
  /** Realistic trees (render/treeModels.ts), replacing the procedural ones once loaded. */
  private trees: THREE.Group | null = null;
  private props: PropDetail | null = null;
  /** The match's skateboard (offline: ours; online: the server's, from snapshots). */
  private board: BoardState | null = null;
  /** The board lying at its spot / where its rider fell, and the one under our feet. */
  private readonly boardLying = buildSkateboard();
  private readonly boardUnder = buildSkateboard();
  private wasRiding = false;
  /** The match's jetpacks (offline: ours, from the map's spots; online: the server's). */
  private jetpacks: JetpackItem[] = [];
  private readonly jetHomes: Vec3[] = [];
  private readonly jet: JetpackPresenter;
  /** Reused per frame: the other players as the jetpack presenter needs them. */
  private readonly jetFlyers: JetFlyer[] = [];
  /** Onto what you would stand on below a point (jetpack spots and drops). */
  private readonly castDown = (from: Vec3): Vec3 => {
    const hit = this.physics.castGroundRay({ ...from, y: from.y + 0.5 }, { x: 0, y: -1, z: 0 }, 30);
    return hit ? { ...hit.point } : { ...from };
  };
  /** Health last frame (a rise within a life = a medkit). */
  private lastHealth = 100;
  private readonly shadowGeometry: ShadowGeometryStats;
  private readonly post: PostPipeline;
  private appliedWeather: WeatherId | null = null;
  private appliedQuality: ResolvedQuality | null = null;
  /** The quality *setting* last applied ('auto' or a fixed tier). */
  private appliedQualitySetting: Quality | null = null;
  private appliedShowFps: boolean | null = null;
  /** For 'auto' quality: seconds spent at the resolution floor while still over budget. */
  private autoTimer = 0;
  /** Auto probing a tier back up: time with headroom, and the wait (doubles after a failed probe). */
  private autoUpTimer = 0;
  private autoUpWait = 60;
  private autoProbedUp = false;
  private readonly drs = new DynamicResolution(0.6);
  /** The display's real refresh (some panels run below 60 Hz): the governor's target. */
  private readonly refresh = new RefreshEstimate();
  /** GPU frame time (where the browser exposes timer queries): headroom for dynamic resolution. */
  private gpuTimer!: GpuFrameTimer;
  private readonly viewmodel = new Viewmodel();
  gunLoadStats: ReturnType<typeof gunScanLoadStats>;
  private readonly effects = new Effects();
  private readonly blastAudioForward = new THREE.Vector3();
  private readonly blastAudioQueue = new BlastAudioQueue();
  private readonly remoteShotAudioQueue = new RemoteShotAudioQueue();
  /** Reused for presentation-only contact lookup at an authoritative remote shot endpoint. */
  private readonly remoteImpactDir = new THREE.Vector3();
  private readonly dummyView: DummyView;
  private readonly actorContacts: ActorContactShadows;
  private readonly contactActorPosition = new THREE.Vector3();
  private readonly hud: Hud;
  /** Hold-Tab scoreboard (forced on by `__wd.scoreboard` for screenshots). */
  private readonly scoreboard: Scoreboard;
  scoreboardForced = false;
  /** In-match chat (online and practice): feed, chat box, quick-chat wheel, mutes. */
  readonly chat: ChatController | null = null;
  private readonly menu: Menu;
  private readonly perf: PerfOverlay;
  readonly audio = new Audio();
  readonly input: Input;

  private readonly physics: PhysicsWorld;
  /** The map in play (with the chosen size applied) and its spawn set. */
  readonly map: MapDefinition;
  /** Soft cover (bushes, tall grass) for sight checks — bots see by the same rules as players. */
  private readonly foliage: FoliageIndex;
  private readonly spawns: SpawnPoint[];
  private readonly mapChoice: {
    map: Settings['map'];
    size: Settings['mapSize'];
    radar: Settings['radar'];
  };
  /** Radar uplinks (collect one: everyone shows on your radar for RADAR.duration). */
  private readonly pickups: PickupState[];
  private readonly pickupView: PickupView;
  private readonly weaponDrops = createWeaponDrops();
  private readonly weaponDropView = new WeaponDropView();
  private truckPromptVisible = false;
  private readonly radar: Radar;
  /** Radar charges (from uplinks) and how long a called-in radar stays live. */
  /** Radar/drone charges, the drone in flight, jamming, spotted marks. */
  private tactical: TacticalState<string> = createTactical<string>();
  private tacPrevButtons = 0;
  /** The view to return to when the drone lands (mouse flies the drone meanwhile). */
  private savedView: { yaw: number; pitch: number } | null = null;
  private dronePrev: { x: number; y: number; z: number } | null = null;
  private smoke: SmokeCloud[] = [];
  /**
   * Online, taken once per frame (sim running or not): the local time the frame samples the
   * network timeline at, and the view time (`vt`) that gives — what remote players are drawn at,
   * what every step of the frame sends and what its smoke is judged and drawn at.
   */
  private frameLocalMs = 0;
  private frameViewTime: number | undefined = undefined;

  /** Sample the frame's network time (`frame` does, before the sim, paused or not). */
  private sampleFrameTime(localMs: number): void {
    this.frameLocalMs = localMs;
    this.frameViewTime = this.online?.viewTime(localMs);
  }

  /**
   * The smoke that is drawn and that hides players: offline the local clouds; online the
   * server's, rewound to the frame's view time (`OnlineSession.smokeAt`, cached per view time,
   * so shots, sight checks and drawing share one list and nothing is allocated per frame).
   */
  private get visibleSmoke(): readonly SmokeCloud[] {
    return this.online ? this.online.smokeAt(this.frameViewTime) : this.smoke;
  }
  private nextSmokeId = 1;
  private readonly smokeView = new SmokeView();
  private readonly jammerFx = new JammerFx();
  private readonly body: RapierCharacter;
  player: PlayerState;
  private prev: PlayerState;
  readonly dummies: DummyState[];
  private seq = 0;
  private accumulator = 0;
  private lastTime = -1;
  private paused = true;
  private stepsThisFrame = 0;

  // Presentation-only feel (never feeds back into the sim).
  private readonly roll = new Spring(22, 0.45);
  /** Online: small reconciliation corrections glide out of the view (~100 ms), never snap it. */
  private readonly correction = new CorrectionSmoother();
  private readonly landDip = new Spring(14, 0.7);
  private readonly sprintFov = new Spring(8, 1);
  /** Slide lean 0..1: camera roll + FOV nudge (the eye drop is the sim's slide eye height). */
  private readonly slideFx = new Spring(12, 1);
  /** Explosion camera shake (presentation only). */
  private readonly shake = new Spring(18, 0.35);
  /** Step smoothing: stairs/kerbs lift the body instantly; the camera glides up instead. */
  private stepOffset = 0;
  private lastFeetY: number | null = null;
  private bobPhase = 0;
  private readonly muzzle = new THREE.Vector3();
  stats = { shots: 0, hits: 0, kills: 0, deaths: 0 };
  /** Live grenades (single-player range: stepped locally; server-side from M3). */
  private grenades: GrenadeState[] = [];
  private nextGrenadeId = 1;
  private appliedMode: Settings['matchMode'] | null = null;
  /** Optional knife sparring partner (a bot on the real input path). */
  private partner: SparringPartner | null = null;
  /** Offline: who the local player bumps into (dummies, the partner); entries reused. */
  private readonly offlineCrowd: CrowdMember[] = [];
  /** The partner bumps into the local player. */
  private readonly partnerCrowd: CrowdMember[] = [{ id: 'local', x: 0, y: 0, z: 0, height: 0 }];
  private readonly partnerView = new PartnerView();
  /**
   * Online match (opt-in): the server owns movement, hits, health and the score; this client
   * predicts itself (and its own shots' effects) and draws the others. Null in single-player
   * (then nothing below is used).
   */
  private readonly online: OnlineSession | null = null;
  private readonly remoteView: RemotePlayersView | null = null;
  private readonly droneView = new DroneView();
  private readonly onlineBadge: OnlineBadge | null = null;
  /** One-time "switch the browser to the discrete GPU" hint (integrated GPU + Auto settling low). */
  private readonly gpuHint: GpuHint;
  private playedSec = 0;
  /** Menu scenery renders at 30 Hz; networking still runs on every animation frame. */
  private menuRenderElapsed = 0;
  /** The joined match room, held so the page leaves it cleanly (unload, settings reload). */
  private readonly onlineLink = new OnlineLink();
  /** Joins at the first Play (with the name typed in the menu); later name edits follow. */
  private readonly onlineJoin: OnlineJoin | null = null;
  private readonly gusts = new WindGusts();
  private readonly windMotes = new WindMotes();
  /** Seconds of recent sprinting (decays at rest): drives breathing. Presentation only. */
  private sprintHeat = 0;
  /** This player's voice (hurt/death sounds), stable per player id. */
  private get myVoice(): number {
    return voiceFor(this.online?.id ?? 'local');
  }

  private rainCoverTimer = 0;

  /** Rain sound under cover: muffled indoors, drumming on a roof close overhead (4 Hz). */
  private updateRainCover(dt: number, rain: number): void {
    this.rainCoverTimer -= dt;
    if (this.rainCoverTimer > 0) return;
    this.rainCoverTimer = 0.25;
    const occ = currentRainOcclusion();
    if (!occ || rain <= 0) return;
    const p = this.camera.position;
    this.audio.setRainCover(rainShelter(occ, p.x, p.y, p.z));
  }

  private updateBreathing(dt: number): void {
    const m = this.player.move;
    const alive = this.player.health > 0;
    // The sim freezes `sprinting` while paused or dead: count only live, unpaused sprinting.
    if (!alive) this.sprintHeat = 0;
    else if (!this.paused) {
      this.sprintHeat = m.sprinting
        ? Math.min(12, this.sprintHeat + dt)
        : Math.max(0, this.sprintHeat - dt * 0.8);
    }
    const winded = Math.min(1, Math.max(0, (this.sprintHeat - 3) / 5));
    const hurt = Math.max(0, (40 - this.player.health) / 40) * 0.9;
    this.audio.setBreathing(alive && !this.paused ? Math.max(winded, hurt) : 0);
  }

  /** Online: tell the server a new loadout primary (it arrives with the next life). */
  private sendLoadout: ((primary: PrimaryId) => void) | null = null;
  private appliedPrimary: PrimaryId | null = null;
  /** Friend lobby: tells the server this player is actually playing (sent once, at first Play). */
  private sendReady: (() => void) | null = null;
  private readyOnce(): void {
    const send = this.sendReady;
    this.sendReady = null;
    send?.();
  }
  /** Per own online shot (input seq): the marker its prediction showed, if any. */
  private readonly onlineShotMarkers = new Map<number, PredictedMarker>();
  /** Online match phase last seen (the result banner shows once per match end). */
  private lastPhase: 'playing' | 'ended' | null = null;
  /** Settings this page forces (`?online`, a friend room, the server): never saved as the player's. */
  private readonly overrides = new PageOverrides();
  private onlineAuthority: FriendMatchSettings | null;
  /** The settings this page's practice match was launched with (null: not practice). */
  private readonly practiceLaunch: FriendMatchSettings | null;
  /** Online name tags: who was in sight at the last check (sight tests run a few times/s). */
  private tagSight = new Map<string, boolean>();
  private tagSightTimer = 0;
  /** Debug/test visibility into the most recent blast. */
  private lastExplosion: {
    pos: { x: number; y: number; z: number };
    distance: number;
    selfDamage: number;
  } | null = null;

  // Cinematic camera moments (presentation only: camera/, never read by the sim).
  private readonly director = new CameraDirector();
  private readonly cinematic = new CinematicCamera(this.director);
  /** What the shot composer reads each frame (filled in place). */
  private readonly shot: ShotInputs;
  private readonly killerSubject = blankSubject();
  private readonly winnerSubject = blankSubject();
  /** Autotest pages start with the moments off (scripted tests expect first person): `&cine`. */
  private cineAllowed: boolean;
  /**
   * The local player's own soldier (the same models and materials as everyone else's, warmed
   * up with them): drawn only while the camera is outside the head.
   */
  private localSoldier: Soldier | null = null;
  /**
   * The match's trucks (online and practice maps with vehicles, when the host has them on), the
   * seat/armour HUD, and the driver's chase camera (pulled in off walls, eased back out).
   */
  vehiclesView: VehiclesView | null = null;
  private vehicleHud: VehicleHud | null = null;
  private readonly chase = new CollisionSmoother();
  private readonly chaseWant = { x: 0, y: 0, z: 0 };
  private readonly chaseHit = { x: 0, y: 0, z: 0 };
  private readonly framing = new FramingSmoother();
  /** The map's tree crowns (the chase camera keeps out of them), and those near the truck. */
  private chaseCrowns: Crown[] = [];
  private readonly chaseNear: Crown[] = [];
  /** The trucks as drawn this frame (the remote-player timeline). */
  private drawnVehicles: VehiclePose[] = [];
  private drawnDrones: readonly RemoteDrone[] = [];
  private readonly onlineSpottedIds = new Set<string>();
  /** Our seat last frame (a change plays the door and the blink). */
  private seatKeyLast: string | null = null;
  /** It was last posed dead or from the replay: sync it to the living player once hidden. */
  private localSoldierStale = false;
  private readonly localPose: SoldierPose = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    crouched: false,
    grounded: true,
    sprinting: false,
    alive: true,
  };
  /** Online: everyone's recent poses (fixed rings), replayed by the kill cam. */
  private readonly replay = new ReplayRecorder(MATCH_NET.maxPlayers);
  private readonly replayPlayers: RemotePlayer[] = Array.from(
    { length: MATCH_NET.maxPlayers },
    () => ({ id: '', name: '', slot: 0, pose: blankPose() }),
  );
  private readonly replayList: RemotePlayer[] = [];
  private readonly selfPose: RemotePose = blankPose();
  private readonly scratchPose: RemotePose = blankPose();
  /** The intro plays once per page, after the first Play; while it plays it can hold `ready`. */
  private introPending = true;
  private playedOnce = false;
  /** A friend room's `ready` (spawn protection) waits for the intro: the sim holds meanwhile. */
  private introHolding = false;
  /** Offline, with a death cam: seconds until the respawn (any press respawns at once). */
  private respawnTimer = 0;
  /**
   * Online death moment: the life it belongs to, and how long we have been alive during it. A
   * kill event that arrives after its respawn (a hidden tab, a stall) must not keep a living
   * player's camera: either ends it.
   */
  private deathLife = -1;
  private lastFrameDt = 0;
  private aliveInDeath = 0;
  /** The other players as drawn last frame (the victory shot follows one; no extra sampling). */
  private lastLive: readonly RemotePlayer[] = [];
  /**
   * The remote players drawn this frame: the live ones, or the kill cam's replay of them. The
   * jetpack exhaust follows the same list, so a replayed flyer burns where its soldier is drawn.
   */
  private drawnRemotes: readonly RemotePlayer[] = [];

  private constructor(
    canvas: HTMLCanvasElement,
    hudHost: HTMLElement,
    private readonly opts: GameOptions,
    renderer: THREE.WebGLRenderer,
    materials: MapMaterials,
  ) {
    this.renderer = renderer;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.shadowGeometry = trackShadowGeometry(this.renderer);
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.enabled = true;
    this.gpuTimer = new GpuFrameTimer(this.renderer.getContext() as WebGL2RenderingContext);

    this.sky = new SkyDome(this.renderer);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target, this.hemi, this.sky.mesh, this.rain.mesh);
    this.materials = materials;
    this.post = new PostPipeline(
      this.renderer,
      this.scene,
      this.camera,
      this.viewmodel.scene,
      this.viewmodel.camera,
    );
    this.weather = new WeatherSystem({
      scene: this.scene,
      sky: this.sky,
      sun: this.sun,
      hemi: this.hemi,
      rain: this.rain,
      setBloom: (v) => this.post.setBloom(v),
      onThunder: (d) => this.audio.thunder(d),
      setRainAudio: (v) => this.audio.setRain(v),
    });

    // The menu shows (and can change) what this page forces: `?online`, a friend room's online
    // state and match settings. Forced over the settings as loaded, so only the player's own
    // changes are ever saved (see PageOverrides).
    const page = pageOnline(
      window.location.search,
      this.settings.online,
      !!(opts.friendRoom ?? opts.friendSettings),
    );
    this.overrides.force(this.settings, 'online', page.online);
    if (opts.friendName) this.settings.playerName = opts.friendName;
    if (opts.friendSettings) this.forceMatchSettings(opts.friendSettings);
    const choice = resolveMapChoice(window.location.search, this.settings, opts.friendSettings);
    this.settings.radar = choice.radar;
    this.settings.map = choice.map;
    this.settings.mapSize = choice.size;
    // A friend room's settings are the host's; practice's are the player's own (a change
    // restarts it with them: `practiceChanges`), so the menu never snaps them back.
    this.onlineAuthority = opts.practice ? null : (opts.friendSettings ?? null);
    this.practiceLaunch = opts.practice ? (opts.friendSettings ?? null) : null;
    this.mapChoice = choice;
    const base = getMap(choice.map);
    const map = resolveMap(base, choice.size);
    this.map = map;
    this.foliage = new FoliageIndex(map.foliage ?? []);
    this.physics = new PhysicsWorld(map);
    const groundDirection = { x: 0, y: -1, z: 0 };
    this.actorContacts = new ActorContactShadows((origin, point, normal) => {
      const hit = this.physics.castVisibleRay(origin, groundDirection, 1.1);
      if (!hit || !hit.visible) return null;
      point.copy(hit.point);
      normal.copy(hit.normal);
      return hit.distance;
    });
    this.scene.add(this.actorContacts.mesh);
    this.effects.setWorldRaycaster(this.physics);
    // Impact chunks come to rest on the drawn paving (map flats lifted over the collision floor).
    this.effects.debris.chunks.setGroundLift(createFlatLift(map.flats ?? []));
    this.chaseCrowns = (map.trees ?? []).map(crownOf);
    this.cineAllowed = !opts.autotest || new URLSearchParams(window.location.search).has('cine');
    this.shot = {
      dt: 0,
      fpPos: new THREE.Vector3(),
      fpQuat: new THREE.Quaternion(),
      fpFov: 70,
      baseFov: 70,
      self: blankSubject(),
      killer: null,
      winner: null,
      wide: wideVantage(
        map.bounds,
        (o, d, max) => this.physics.castRay(o, d, max)?.distance ?? null,
      ),
      cast: (o, d, max, normal) => {
        const hit = this.physics.castRay(o, d, max);
        if (!hit) return null;
        if (normal) {
          normal.x = hit.normal.x;
          normal.y = hit.normal.y;
          normal.z = hit.normal.z;
        }
        return hit.distance;
      },
    };
    // Big maps generate spawns from the physics world (deterministic: same set on the server).
    this.spawns = map.spawns.length ? map.spawns : spawnsFor(this.physics, base, map, choice.size);
    if (!this.spawns.length) throw new Error(`map ${map.name}: no valid spawn points`);
    this.camera.far = map.viewDistance ?? 600;
    this.camera.updateProjectionMatrix();
    const spawn = this.spawns[0]!;
    this.body = this.physics.createCharacter(spawn.pos);
    this.player = createPlayerState(spawn.pos, 1, this.settings.matchMode, this.settings.primary);
    this.prev = clonePlayerState(this.player);
    this.dummies = createDummies(this.settings.online ? [] : map.dummies);

    setGroundDetailMap(map);
    setCourtyardBakeMap(map);
    setMarketNeonBakeMap(map);
    setMarketNeonStaticBakeMap(map);
    setRainOcclusionMap(map);
    const mapGroup = buildMapMeshes(map, this.materials);
    this.facade = findFacadeDetail(mapGroup);
    this.dressing = buildSetDressing(map, this.materials);
    this.marketDistrictDetail = buildMarketDistrictDetail(map, this.materials);
    this.effects.setDecalLift(marketDetailDecalLift(this.marketDistrictDetail));
    this.scene.add(mapGroup, this.dressing, this.marketDistrictDetail);
    this.neonDistrict = new NeonDistrict(map);
    this.scene.add(this.neonDistrict.group);
    this.dummyView = new DummyView(this.dummies);
    this.scene.add(this.dummyView.group, this.effects.group, this.camera, this.partnerView.group);
    // Online tactical state is server-owned: until snapshots arrive, show what the server will
    // hold (medkits, uplinks unless a friend host turned radar off; quick matches keep radar);
    // Drone/jammer inputs now flow through PlayerState; PickupView follows the snapshots by id.
    this.pickups = createPickups(
      this.settings.online
        ? matchPickupDefs(map.pickups ?? [], opts.friendSettings?.radar ?? 'uplinks')
        : (map.pickups ?? []).filter((p) => choice.radar === 'pickups' || p.kind !== 'radar'),
    );
    // The skateboard's secret spot (Kiran): cast onto its floor, like the server does.
    const spot = map.skateboard;
    const mb = map.bounds;
    if (spot && spot.x >= mb.minX && spot.x <= mb.maxX && spot.z >= mb.minZ && spot.z <= mb.maxZ) {
      this.board = createBoard(
        boardSpawn(spot, (from) => this.physics.castRay(from, { x: 0, y: -1, z: 0 }, 5)),
      );
    }
    // Jetpacks: the map's three spots (in this size's bounds), cast onto the floor like the server.
    for (const s of map.jetpacks ?? []) {
      if (s.x < mb.minX || s.x > mb.maxX || s.z < mb.minZ || s.z > mb.maxZ) continue;
      this.jetHomes.push(this.castDown(s));
    }
    this.jetpacks = createJetpacks(this.jetHomes);
    this.boardLying.visible = this.board !== null;
    this.boardLying.rotation.y = 0.5;
    this.boardUnder.visible = false;
    this.scene.add(this.boardLying, this.boardUnder);
    this.pickupView = new PickupView(this.pickups);
    this.scene.add(
      this.pickupView.group,
      this.weaponDropView.group,
      this.smokeView.group,
      this.jammerFx.group,
    );
    this.scene.add(this.windMotes.points);
    if (this.settings.online) {
      // Built before warmUp, so the remote figures' shaders compile with everything else.
      this.online = new OnlineSession();
      // Props trucks smash or knock over change this client's world as the server's.
      this.online.props.physics = this.physics;
      this.remoteView = new RemotePlayersView();
      this.scene.add(this.remoteView.group, this.droneView.group);
      this.online.onWelcome = (w) => this.onWelcome(w);
      this.online.onRoster = (r) => {
        const id = this.online?.id;
        const me = id ? r.players.find((p) => p.id === id) : undefined;
        if (me) this.onlineJoin?.serverName(me.name);
      };
      this.onlineJoin = new OnlineJoin((name) => this.joinOnline(name));
      // The trucks (the host's setting; quick join has them on): built before warm-up.
      const spots = (map.vehicles ?? []).filter(
        (s) => s.x >= mb.minX && s.x <= mb.maxX && s.z >= mb.minZ && s.z <= mb.maxZ,
      );
      if (spots.length && (opts.friendSettings?.vehicles ?? 'on') === 'on') {
        this.vehiclesView = new VehiclesView(
          this.physics,
          (map.vehicles ?? []).flatMap((s, i) =>
            spots.includes(s) ? [{ id: i + 1, x: s.x, y: s.y ?? 0, z: s.z, yaw: s.yaw }] : [],
          ),
        );
        this.scene.add(this.vehiclesView.group);
      }
    }

    this.hud = new Hud(hudHost);
    if (this.vehiclesView) this.vehicleHud = new VehicleHud(this.hud.root);
    // Jetpacks: pickups, exhaust, the HUD module, feel and sound (presentation only).
    this.jet = new JetpackPresenter(this.hud.root, this.jetHomes);
    this.scene.add(this.jet.group);
    this.jet.onPickup = () =>
      this.hud.banner(`JETPACK — ${this.keyFor('jump')} again in the air to ignite`, 3);
    this.scoreboard = new Scoreboard(this.hud.root);
    this.radar = new Radar(hudHost);
    // Hidden when radar is off, or the map has no uplinks (e.g. the test range).
    // Shown whenever there are uplinks: with radar 'off' it still shows drone uplinks and
    // the drone's spots (there is just nothing to call in).
    this.radar.setVisible(this.pickups.length > 0);
    const rendererName = webglRendererName(this.renderer.getContext());
    this.perf = new PerfOverlay(hudHost, rendererName);
    if (this.online) {
      const s = this.settings;
      const label = opts.practice
        ? `PRACTICE · ${opts.friendSettings?.botCount ?? s.botCount} bots · ${(opts.friendSettings?.botDifficulty ?? s.botDifficulty).toUpperCase()}`
        : undefined;
      this.onlineBadge = new OnlineBadge(hudHost, label);
    }
    this.gpuHint = new GpuHint(hudHost, isIntegratedGpu(rendererName));
    this.input = new Input(
      canvas,
      () => this.settings,
      () => this.zoomSensScale(),
    );
    this.input.yaw = spawn.yaw;
    if (this.online) {
      this.chat = new ChatController(this.hud.root, {
        mode: () => this.settings.chatMode,
        me: () => this.online?.id ?? null,
        palette: SLOT_COLORS,
        release: () => this.input.release(),
        muteTarget: (n) => this.scoreboard.idForKey(n),
        nameOf: (id) => this.online?.roster.find((r) => r.id === id)?.name ?? null,
      });
      this.input.modal = this.chat;
    }
    this.menu = new Menu(
      hudHost,
      this.settings,
      () => this.applySettings(),
      (fs) => void this.play(fs),
      (done) => this.input.captureNext(done),
      (s, changed) => saveSettings(this.overrides.toSave(s, changed)),
      () => this.openFriendLobby(),
      {
        practice: opts.practice === true,
        onPractice: () => this.togglePractice(),
        practicePending: () => this.practiceChanged().length > 0,
        onRestartPractice: () => this.restartPractice(),
        canEndMatch: () => this.online?.canEndMatch ?? false,
        onEndMatch: () => void this.online?.endMatch(),
      },
    );
    this.input.onLockChange = (locked) => {
      if (this.opts.autotest) return;
      this.paused = !locked;
      // Practice vs bots pauses like single player: the local match waits while the menu is up.
      if (this.opts.practice) this.setPracticePaused(!locked);
      if (locked) this.menu.hide();
      else this.menu.show(true);
    };
    canvas.addEventListener('click', () => {
      if (!this.input.locked && !this.opts.autotest) void this.play(false);
    });
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.perf.toggle();
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.input.locked) e.preventDefault(); // guard against Ctrl+W while crouch-walking
    });
    // Tab closed, reloaded or navigated away: leave the match with consent (queued ahead of the
    // socket's close), so the server frees the seat now instead of keeping a ghost for 20 s.
    window.addEventListener('pagehide', () => void this.onlineLink.leave());
    // Back/Forward restored this page from the bfcache after that leave: the room is gone for
    // good (and the join is spent), so a fresh load is the only way back online.
    window.addEventListener('pageshow', (e) => {
      if (this.online && this.onlineLink.restoredFromCache(e.persisted)) window.location.reload();
    });

    if (opts.friendRoom && this.online && this.onlineJoin) {
      this.onlineJoin.attach(nameSender(opts.friendRoom));
      this.onlineJoin.adoptJoined(this.settings.playerName);
      // Friend and practice rooms: their host may End match (quick-join rooms can't).
      wireOnlineRoom(this.online, this.onlineLink, opts.friendRoom, opts.friendBuffer, {
        endMatch: true,
      });
      this.chat?.attach(opts.friendRoom);
      // What was said while the game was being built (the lobby kept it).
      this.chat?.replay(opts.friendBuffer?.chats?.splice(0) ?? []);
      if (opts.practice) {
        // Practice waits on the menu like single player (no bots fight a player still
        // choosing); the session's clock waits with it.
        if (!opts.autotest) this.setPracticePaused(true);
        // A worker that failed (even before this point) says so, with the way back.
        opts.friendRoom.onLeave((code, reason) => {
          if (code === 1000) return;
          this.hud.banner(`${reason ?? 'Practice match stopped'} — Esc › Leave practice`, 30);
        });
      }
    }

    this.applySettings();
    this.startOfflineLife();
    this.resize();
    void this.audio.preload();
    if (opts.autotest) {
      this.paused = false;
      this.menu.hide();
      this.input.scripted = { buttons: 0, moveX: 0, moveZ: 0 };
    } else {
      this.menu.show(false);
    }
  }

  static async create(
    canvas: HTMLCanvasElement,
    hudHost: HTMLElement,
    opts: GameOptions,
  ): Promise<Game> {
    // Loading-screen stages. A stage whose work is one long synchronous block (surfaces, map)
    // is reported and painted first. The renderer and surfaces are made here (they were the
    // constructor's first steps) so the map build is its own stage; the work's order is the same.
    const boot = opts.boot;
    const report = boot?.report ?? (() => {});
    report('physics');
    await initPhysics();
    report('surfaces');
    await boot?.paint();
    const renderer = new THREE.WebGLRenderer({
      canvas,
      // Single-sampled canvas: Low antialiases in its own MSAA target (render/lowFrame.ts) and
      // Medium+ with SMAA; a multisampled canvas only added a resolve to every frame.
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    // Every procedural surface set, generated on the CPU (~6 s).
    const materials = new MapMaterials(renderer.capabilities.getMaxAnisotropy());
    const choice = resolveMapChoice(window.location.search, loadSettings(), opts.friendSettings);
    boot?.setLabel('map', mapStageLabel(choice.map, choice.size));
    report('map');
    await boot?.paint();
    const game = new Game(canvas, hudHost, opts, renderer, materials);
    report('assets', 0);
    // Prepare both sides of the Low boundary before play, including a session starting on Low.
    setBakedLighting(game.scene, true);
    // Scanned surfaces + HDRI lighting load (and upload) before warm-up, so warm-up compiles
    // exactly what play draws. Anything that fails keeps the procedural version (a warning).
    // Texture size follows the tier resolved now (the setting, or where Auto settled last time):
    // Low loads 512 px sets for the whole session.
    const fallback =
      <T>(what: string, v: T) =>
      (e: unknown) => {
        console.warn(`${what} unavailable, using procedural (${String(e)})`);
        return v;
      };
    // Baked lightmaps (Medium+ on the Market) load in the same wait, all before warm-up.
    // CC0 prop models (crates, barriers, street dressing) replace their fallback surfaces;
    // failed loads retain the same silhouettes (render/propModels.ts).
    // Scanned guns first: the soldiers carry the viewmodel's scans (whichever gun is in hand).
    const gunsLoad = loadGunScans(game.renderer, { lowRes: game.quality === 'low' }).catch(
      fallback('gun scans', null),
    );
    // The seax knife model (viewmodel, soldiers, partner); failure keeps the procedural knives.
    const knifeLoad = loadKnifeModel(game.renderer, { lowRes: game.quality === 'low' }).catch(
      fallback('knife model', null),
    );
    // The arms' knife pose shares the guns' arms material (failure keeps the primitive fist).
    const knifeArmsLoad = gunsLoad
      .then((g) => {
        const material = g?.get('rifle')?.arms?.material;
        return material ? loadKnifeArms(material) : null;
      })
      .catch(fallback('knife arms', null));
    const soldiersLoad = Promise.all([gunsLoad, knifeLoad])
      .then(([g, k]) => loadSoldiers(game.renderer, g ? thirdPersonModels(g, k) : {}))
      .catch(fallback('soldiers', null));
    // Asset progress = loads settled (loaded or fallen back) out of all of them.
    let settled = 0;
    let count = 0;
    const tick = (): void => report('assets', ++settled / count);
    const track = <T>(p: Promise<T>): Promise<T> => {
      count++;
      void p.then(tick, tick);
      return p;
    };
    const [, env, props, , , , heroes, trees, guns, soldiers, medkit, knife, knifeArms, jetpack] =
      await Promise.all([
        track(
          game.materials
            .loadTextures(game.renderer, { lowRes: game.quality === 'low' })
            .catch(fallback('surface textures', [])),
        ),
        track(
          EnvironmentLibrary.load(game.renderer, Object.keys(WEATHER_PRESETS) as WeatherId[]).catch(
            fallback('environment maps', new EnvironmentLibrary()),
          ),
        ),
        track(
          loadPropModels(game.renderer, { lowRes: game.quality === 'low' }).catch((e: unknown) => {
            console.warn(`prop models unavailable, drawing greybox props (${String(e)})`);
            return null;
          }),
        ),
        track(game.uploadLightmaps()),
        // Scan-baked leaf mass for bush cores and tree crowns (fills the atlas in place).
        track(loadCanopyScan(game.renderer).catch(fallback('canopy scan', undefined))),
        // Photographed sunny sky (CC0 Poly Haven pure-sky HDRI, tools/assets/build_sky.py).
        track(
          game.sky
            .loadPhoto(
              game.renderer,
              `${import.meta.env.BASE_URL}env/sky_sunny${game.quality === 'low' ? '_low' : ''}.webp`,
              4,
            )
            .then(() => game.weather.skyPhotoReady())
            .catch(fallback('sky photo', undefined)),
        ),
        // Generated hero models (burnt car, food truck, kiosk); failure draws their body boxes.
        track(
          loadHeroModels(game.renderer, { lowRes: game.quality === 'low' }).catch(
            fallback('hero models', null),
          ),
        ),
        // Realistic trees (EZ-Tree bake): near models + impostors; failure keeps the old trees.
        track(loadTreeModels(game.renderer).catch(fallback('tree models', null))),
        // Scanned first-person guns (generated models); failure keeps the primitive guns.
        track(gunsLoad),
        // Rocketbox soldiers (UAL clips) for dummies and other players; failure keeps the figures.
        track(soldiersLoad),
        // The generated medkit case (a hero-built prop).
        track(
          loadHeroModel(game.renderer, 'medkit', { lowRes: game.quality === 'low' }).catch(
            fallback('medkit model', null),
          ),
        ),
        track(knifeLoad),
        track(knifeArmsLoad),
        // The jetpack (tools/assets/build_jetpack.py); failure keeps a primitive stand-in.
        track(
          loadJetpackModel(game.renderer, { lowRes: game.quality === 'low' }).catch(
            fallback('jetpack model', null),
          ),
        ),
        track(loadCourtyardBake(game.renderer).catch(fallback('Palace entrance bake', false))),
        track(
          loadMarketNeonBake(game.renderer)
            .then((loaded) => {
              if (loaded)
                game.neonDistrict.setBakedGroundSigns(
                  MARKET_NEON_BAKE.emitters.map((e) => e.label),
                );
              return loaded;
            })
            .catch(fallback('Night-market illumination', false)),
        ),
        track(
          loadMarketNeonStaticBake(game.renderer).catch(
            fallback('Night-market surface light', false),
          ),
        ),
        track(loadPalaceColumnTextures(game.renderer, game.scene)),
      ]);
    // The art lane's truck model, if it has landed (same node layout); else the placeholder.
    if (game.vehiclesView)
      await game.vehiclesView.useModel(`${import.meta.env.BASE_URL}models/vehicles/truck.glb`);
    report('setup');
    if (guns) {
      game.gunLoadStats = gunScanLoadStats(guns);
      game.viewmodel.useScannedGuns(guns);
      game.weaponDropView.useScannedGuns(guns);
    }
    if (knife) {
      game.viewmodel.useKnifeModel(knife, knifeArms);
      game.partnerView.useKnifeModel(knife);
    }
    game.viewmodel.onCue = (cue, gun) => game.audio.foley(cue, gun);
    if (medkit) game.pickupView.useMedkitModel(medkit[1]);
    if (jetpack) game.jet.useModel(jetpack);
    if (soldiers) {
      soldiers.footSupport = (x, y, z) => {
        const hit = game.physics.castVisibleRay({ x, y, z }, { x: 0, y: -1, z: 0 }, 1.2);
        return hit && hit.normal.y > 0.65 ? hit.point.y : null;
      };
      // Everyone can wear a jetpack on their back (hidden until worn).
      soldiers.jetpack = game.jet.soldierKit;
      game.dummyView.useSoldiers(soldiers);
      game.remoteView?.useSoldiers(soldiers);
      // The knife sparring partner too (capsule figure if the soldiers failed to load).
      game.partnerView.useSoldiers(soldiers);
      // Our own body, for the camera moments (hidden now; warm-up compiles it with the rest).
      game.localSoldier = new Soldier(soldiers, 0);
      game.localSoldier.root.name = 'local-soldier';
      game.localSoldier.root.visible = false;
      game.scene.add(game.localSoldier.root);
    }
    if (trees) {
      const old: THREE.Object3D[] = [];
      game.scene.traverse((o) => {
        if (o.name === 'trees') old.push(o);
      });
      for (const o of old) o.removeFromParent();
      game.trees = buildTreeMeshes(game.map, trees);
      game.scene.add(game.trees);
    }
    game.heroes = buildHeroMeshes(game.map, heroes);
    game.scene.add(game.heroes);
    game.props = installPropModels(game.scene, game.map, props);
    game.renderAssetsReady = true;
    game.weather.setEnvironments(env);
    game.facade?.setEnvironment(game.weather.environmentMap, game.scene.environmentIntensity);
    game.viewmodel.setEnvironment(game.weather.environmentMap, game.scene.environmentIntensity);
    // Baked ceiling-lamp light on everything that moves (render/lampLight.ts; Medium+ only, a
    // no-op volume on maps without a bake). Patched before warm-up so both tiers compile now.
    for (const g of [
      game.dummyView.group,
      game.remoteView?.group,
      game.droneView.group,
      game.partnerView.group,
      game.pickupView.group,
      game.weaponDropView.group,
      game.jet.group,
      game.boardLying,
      game.boardUnder,
      game.heroes,
      game.localSoldier?.root,
      game.vehiclesView?.group,
    ]) {
      if (g) applyLampVolume(g, 'world');
    }
    applyLampVolume(game.viewmodel.scene, 'camera');
    report('shaders', 0);
    await game.warmUp((done) => report('shaders', done));
    // Friend lobby: the match started while this client loaded. Built and warmed up now, but the
    // player is still on the menu: `ready` (the server puts them into the fight; until then
    // nobody can hit them) goes at their first Play, or its 20 s server timeout.
    if (opts.friendRoom) {
      const room = opts.friendRoom;
      game.sendLoadout = (primary) => room.send('loadout', { primary } satisfies LoadoutMessage);
      game.sendReady = () => {
        const ready: ReadyMessage = {};
        room.send('ready', ready);
      };
    }
    return game;
  }

  /**
   * Upload baked lighting before warm-up, including a Low session that may later change tier,
   * so no PNG decode or texture upload lands mid-match. Only Medium+ samples these textures.
   */
  private async uploadLightmaps(): Promise<void> {
    for (const tex of await bakedLightingReady(this.scene)) this.renderer.initTexture(tex);
  }

  /**
   * Compile every shader before play (smoothness): otherwise the first sight of a new material,
   * weapon or effect compiles its program mid-game — a 100–200 ms hitch on integrated GPUs.
   * Hidden objects (other weapons, pooled effects) are shown for the compile, then restored.
   */
  private async warmUp(progress: (done: number) => void = () => {}): Promise<void> {
    const contactMaterial = this.actorContacts.mesh.material as THREE.MeshBasicMaterial;
    if (contactMaterial.map) this.renderer.initTexture(contactMaterial.map);
    // Tactical effects build their meshes on first use: create one of each for the compile
    // (a smoke cloud and a jammer ring out of sight), then clear them.
    this.smokeView.update(0, [{ id: -1, pos: { x: 0, y: -500, z: 0 }, age: 1 }], 0);
    this.jammerFx.pulse({ x: 0, y: -500, z: 0 });
    // Compile the shared grenade material too, before the first online `nade` event.
    this.effects.addGrenade(0);
    // Draw all impact buffers, including atlas decals, before the first combat hit.
    const restoreImpacts = this.effects.beginWarmUp();
    // The trucks' tyre dust and skid ribbons: drawn once before the first slide.
    const restoreTyres = this.vehiclesView?.beginWarmUp();
    const restoreDrops = this.weaponDropView.beginWarmUp();
    const hidden: THREE.Object3D[] = [];
    for (const sc of [this.scene, this.viewmodel.scene]) {
      sc.traverse((o) => {
        if (!o.visible) {
          hidden.push(o);
          o.visible = true;
        }
      });
    }
    const quality = this.quality;
    const target = this.renderer.getRenderTarget();
    const toneMapping = this.renderer.toneMapping;
    const hdr = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    const draws = warmDrawTiers(this.appliedQualitySetting, quality);
    // Loading-screen progress: two tiers of five compile steps, then one step per tier drawn.
    let step = 0;
    const steps = 10 + draws.length;
    const stepped = (): void => progress(Math.min(1, ++step / steps));
    try {
      for (const tier of ['low', 'medium'] as const) {
        this.setWorldQuality(tier);
        // Low draws into its own MSAA target (render/lowFrame.ts): compile with it bound.
        this.renderer.setRenderTarget(tier === 'low' ? this.post.lowTarget : hdr);
        this.renderer.toneMapping = tier === 'low' ? THREE.AgXToneMapping : THREE.NoToneMapping;
        // The world and its custom depth materials are warmed with both fog/IBL/map defines.
        await warmFoliage(this.renderer, this.scene, this.camera);
        stepped();
        await this.renderer.compileAsync(this.scene, this.camera);
        stepped();
        await this.renderer.compileAsync(this.viewmodel.scene, this.viewmodel.camera);
        stepped();
        await this.props?.warmUp(this.renderer, this.camera, this.scene);
        await this.vehiclesView?.warmUp(this.renderer, this.camera, this.scene);
        stepped();
        await this.facade?.warmUp(this.renderer, this.camera, this.scene);
        stepped();
        this.post.prepass.warm(this.renderer, this.scene, this.camera);
        if (tier === 'low') this.post.warmLowPresent();
      }
    } catch (error) {
      // compileAsync is an optimisation; the game still works (with first-sight compiles).
      console.warn('Shader warm-up incomplete; rendering will retry on first use.', error);
    } finally {
      this.setWorldQuality(quality);
      this.renderer.setRenderTarget(target);
      this.renderer.toneMapping = toneMapping;
      hdr.dispose();
      // Draw everything once through the real pipeline, not only compile: the driver (ANGLE on
      // D3D11) finishes shader variants, buffer uploads and texture residency on the first real
      // draw, so anything first drawn mid-play cost a 50–180 ms frame (and pushed Auto down a
      // tier). Hidden objects (other guns, the board) are still visible here. Under Auto, every
      // tier the governor can step down to is drawn as well, through `setQuality` (shadow map,
      // post chain, tone mapping, world quality, the Low recompile pass), ending on the start tier.
      try {
        for (const tier of draws) {
          this.setQuality(tier);
          this.uploadAllGeometry();
          stepped();
        }
        // Every post chain the tier governor can pick compiles now (a tier change then only
        // selects one); a fixed Low never draws them, so it skips the work.
        if (this.appliedQualitySetting !== 'low') this.post.warmTiers();
      } finally {
        this.setQuality(quality); // a no-op unless a draw threw before the start tier's
        restoreImpacts();
        restoreTyres?.();
        restoreDrops();
      }
      for (const o of hidden) o.visible = false;
      this.smokeView.update(0, [], 0);
      this.jammerFx.update(10);
      this.effects.update(0, []);
    }
  }

  /**
   * Draw everything once through the real render path, frustum culling off (hidden objects are
   * still visible during warm-up), then again with every LOD on its far geometry.
   */
  private uploadAllGeometry(): void {
    const culled: THREE.Object3D[] = [];
    for (const sc of [this.scene, this.viewmodel.scene]) {
      sc.traverse((o) => {
        if (o.frustumCulled) {
          culled.push(o);
          o.frustumCulled = false;
        }
      });
    }
    const far = new THREE.Vector3(1e6, 0, 1e6);
    // THREE.LOD objects (sandbag walls) pick one level per draw: show them all for both passes.
    const restoreLods = showAllLodLevels(this.scene);
    const restoreProduce = showProduceDetailForWarmup(this.dressing);
    try {
      for (const pass of ['near', 'far'] as const) {
        if (pass === 'far') {
          if (this.heroes) updateHeroes(this.heroes, far);
          this.props?.update(far);
        }
        this.post.render(0);
      }
    } finally {
      for (const o of culled) o.frustumCulled = true;
      restoreLods();
      restoreProduce();
      if (this.heroes) updateHeroes(this.heroes, this.camera.position);
      this.props?.update(this.camera.position);
    }
  }

  /**
   * Must be called from a click handler. Pointer lock and fullscreen both need the click's
   * transient user activation, so both are requested synchronously before any await; awaiting
   * fullscreen first can let the activation lapse and get pointer lock denied.
   */
  async play(fullscreen: boolean): Promise<void> {
    this.audio.unlock();
    const lock = this.input.requestLock();
    // Online: the first Play joins the match, with the name the menu shows now.
    this.onlineJoin?.start(this.settings.playerName);
    this.playedOnce = true;
    // A friend room's `ready` waits for the intro (spawn protection covers the fly-over).
    if (!this.maybeStartIntro()) this.readyOnce();
    if (fullscreen && !document.fullscreenElement) {
      const fs = document.documentElement
        .requestFullscreen({ navigationUI: 'hide' })
        .then(async () => {
          const kb = (
            navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void> } }
          ).keyboard;
          await kb?.lock?.(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ControlLeft', 'Space']);
        })
        .catch(() => {
          // fullscreen or keyboard lock denied: play windowed
        });
      await Promise.all([lock, fs]);
    } else {
      await lock;
    }
  }

  private applySettings(): void {
    const s = this.settings;
    if (this.onlineAuthority) {
      s.map = this.onlineAuthority.map;
      s.mapSize = this.onlineAuthority.size;
      s.matchMode = this.onlineAuthority.mode;
      s.radar = matchRadarToGameRadar(this.onlineAuthority.radar);
      s.weather = this.onlineAuthority.weather;
    }
    // The completed online name is sent on Play/resume; per-keystroke settings updates would
    // exhaust the server's name-change bucket and silently lose the final name.
    this.audio.setVolume(s.masterVolume);
    this.hud.setCrosshairColor(s.crosshairColor);
    if (s.showFps !== this.appliedShowFps) {
      this.appliedShowFps = s.showFps;
      this.perf.setVisible(s.showFps);
    }
    this.input.rebuildBindings();
    // Map size only matters on maps with sections (the range has one fixed size).
    const sized = (m: Settings['map'], z: Settings['mapSize']): string =>
      m === 'range' ? 'full' : z;
    if (
      (this.online === null && s.radar !== this.mapChoice.radar) ||
      s.map !== this.mapChoice.map ||
      sized(s.map, s.mapSize) !== sized(this.mapChoice.map, this.mapChoice.size) ||
      s.online !== (this.online !== null) ||
      // Online, the loadout is the room's (rooms are matched by it): a change means another room.
      (this.online !== null && this.appliedMode !== null && s.matchMode !== this.appliedMode)
    ) {
      // The map is built once per session (physics, meshes, spawns): a change reloads the game.
      // Settings are already saved by the menu.
      const url = new URL(window.location.href);
      url.searchParams.set('map', s.map);
      url.searchParams.set('size', s.mapSize);
      url.searchParams.set('radar', s.radar);
      url.searchParams.set('online', s.online ? '1' : '0');
      if (!s.online) {
        url.searchParams.delete('room');
        url.searchParams.delete('lobby');
        // Unticking online leaves practice too (it plays through the online path).
        url.searchParams.delete('practice');
      }
      // Leave the match first (briefly waiting for it to go out): the reloaded page joins anew.
      void this.onlineLink.leave().then(() => window.location.replace(url.toString()));
      return;
    }
    // The sparring partner is a local bot: single-player only (online bots come server-side).
    if (s.sparring && !this.partner && !this.online) {
      // The map's sparring spot, or a little way in front of the player.
      const m = this.player.move.pos;
      const yaw = this.input.yaw;
      const spot = this.map.sparringSpot ?? {
        x: m.x - Math.sin(yaw) * 10,
        y: m.y,
        z: m.z - Math.cos(yaw) * 10,
      };
      this.partner = new SparringPartner(this.physics, (near) => this.clearSpot(near), spot);
    } else if ((!s.sparring || this.online) && this.partner) {
      this.partner.dispose();
      this.partner = null;
      this.partnerView.group.visible = false;
    }
    if (s.matchMode !== this.appliedMode) {
      const first = this.appliedMode === null;
      this.appliedMode = s.matchMode;
      if (!first) {
        // A new loadout rule starts clean: no projectiles from the previous mode.
        this.grenades = [];
        this.respawn();
      }
    }
    this.materials.setGrid(s.showGrid);
    if (s.primary !== this.appliedPrimary) {
      // Offline the next respawn reads the setting; online the server hands out the next life.
      if (this.appliedPrimary !== null) this.sendLoadout?.(s.primary);
      this.appliedPrimary = s.primary;
    }
    if (s.weather !== this.appliedWeather) {
      this.appliedWeather = s.weather;
      this.weather.apply(s.weather);
      this.facade?.setEnvironment(this.weather.environmentMap, this.scene.environmentIntensity);
      this.neonDistrict.setEnabled(s.weather === 'neon');
      document.body.dataset.visualTheme = s.weather === 'neon' ? 'neon' : 'classic';
      this.audio.setWind(windStrengthFor(WEATHER_PRESETS[s.weather]));
      this.viewmodel.setEnvironment(this.weather.environmentMap, this.scene.environmentIntensity);
    }
    const enteringAuto = s.quality === 'auto' && this.appliedQualitySetting !== 'auto';
    this.appliedQualitySetting = s.quality;
    if (s.quality !== 'auto') this.setQuality(s.quality);
    else if (enteringAuto) {
      // Start where this machine settled last time (no convergence hitches in play).
      const mem = loadPerfMemory();
      this.setQuality(mem?.quality ?? AUTO_START);
      this.drs.reset(mem?.scale ?? this.drs.max);
      if (!mem) this.drs.fastStart();
    }
    this.resize();
  }

  private renderAssetsReady = false;

  private setWorldQuality(q: ResolvedQuality): void {
    this.weather.setLowQuality(q === 'low');
    setBakedLighting(this.scene, q !== 'low');
    setFoliageQuality(q);
    if (this.renderAssetsReady) {
      setRenderBudget(this.scene, q);
      this.post.refreshWorld();
    }
  }

  private setQuality(q: ResolvedQuality): void {
    if (q === this.appliedQuality) return;
    // Only crossing the Low boundary changes tone mapping (a shader define); other tier
    // changes keep every compiled program (recompiling everything is a long freeze).
    const recompile =
      this.appliedQuality === null || (q === 'low') !== (this.appliedQuality === 'low');
    this.appliedQuality = q;
    this.autoTimer = 0;
    const sh = SHADOWS[q];
    this.sun.shadow.mapSize.set(sh.size, sh.size);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    const cam = this.sun.shadow.camera;
    cam.left = -sh.half;
    cam.right = sh.half;
    cam.top = sh.half;
    cam.bottom = -sh.half;
    cam.near = 1;
    cam.far = 520; // sun sits 250 m out: the whole Palace tower fits in the shadow frustum
    cam.updateProjectionMatrix();
    this.post.setQuality(q);
    this.facade?.setQuality(q);
    this.setWorldQuality(q);
    if (recompile) {
      // The Low/Medium shader variants were compiled during warmUp; this selects cached programs.
      this.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            if (m instanceof THREE.Material) m.needsUpdate = true;
          }
        }
      });
    }
  }

  /**
   * Frame-time governor. Dynamic resolution absorbs load first (integrated GPUs are fill-rate
   * bound); in 'auto' quality, if resolution is already at its floor and frames still miss the
   * budget for 3 s, drop one quality tier. With sustained headroom at full resolution it probes
   * one tier back up (rarely, with back-off: each tier change can be a hitch).
   */
  private govern(dt: number): void {
    if (this.paused || (this.opts.autotest && !this.opts.governor)) return;
    const s = this.settings;
    this.playedSec += dt;
    this.gpuHint.update(dt, {
      auto: s.quality === 'auto',
      fps: this.perf.fps,
      resolutionScale: s.dynamicResolution ? this.drs.scale : 1,
      playedSec: this.playedSec,
    });
    this.drs.setBudget(this.refresh.ms);
    if (s.dynamicResolution && this.drs.update(dt * 1000, this.gpuTimer.median())) {
      this.resize();
      if (s.quality === 'auto') savePerfMemory(this.quality, this.drs.scale);
    }
    if (s.quality !== 'auto') return;
    // "Slow" and "roomy" are relative to what the display can show (58 of 60 at 60 Hz).
    const targetFps = this.refresh.fps - 2;
    const slow = this.perf.fps > 0 && this.perf.fps < targetFps;
    const floor = !s.dynamicResolution || this.drs.exhausted;
    this.autoTimer = slow && floor ? this.autoTimer + dt : 0;
    const idx = QUALITY_STEPS.indexOf(this.quality);
    if (this.autoTimer > 3 && idx > 0) {
      // One step down; keep the current resolution (it probes up later if there's headroom)
      // rather than resetting and walking down again (each step is a resize hitch).
      this.setQuality(QUALITY_STEPS[idx - 1]!);
      this.drs.reset(this.drs.scale);
      this.resize();
      savePerfMemory(this.quality, this.drs.scale);
      // Dropping right after a probe up means that tier doesn't fit: wait longer next time.
      if (this.autoProbedUp) this.autoUpWait = Math.min(this.autoUpWait * 2, 600);
      this.autoProbedUp = false;
      this.autoTimer = 0;
      this.autoUpTimer = 0;
      return;
    }
    // Headroom at full resolution below the Auto start tier (e.g. a remembered Low from a bigger
    // screen or a busier day): after a sustained quiet spell, try one tier up. A remembered tier
    // is a starting point, never a ceiling.
    const roomy =
      this.perf.fps >= targetFps && (!s.dynamicResolution || this.drs.scale >= this.drs.max);
    this.autoUpTimer = roomy ? this.autoUpTimer + dt : 0;
    if (this.autoUpTimer > this.autoUpWait && idx < QUALITY_STEPS.indexOf(AUTO_START)) {
      this.setQuality(QUALITY_STEPS[idx + 1]!);
      this.resize();
      savePerfMemory(this.quality, this.drs.scale);
      this.autoProbedUp = true;
      this.autoUpTimer = 0;
    }
  }

  /** Effective internal resolution scale (for the perf overlay and tests). */
  get resolutionScale(): number {
    return this.settings.renderScale * (this.settings.dynamicResolution ? this.drs.scale : 1);
  }

  get quality(): ResolvedQuality {
    return this.appliedQuality ?? 'high';
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.drs.max = 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1) * this.resolutionScale);
    this.gpuTimer?.reset(); // its samples describe the old resolution
    this.renderer.setSize(w, h, false);
    this.post.setSize();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.effects.setImpactView(this.camera, h, this.quality === 'low');
    this.viewmodel.resize(w / h);
  }

  /** Current vertical FOV (degrees) including ADS zoom and sprint widening. */
  private currentVfov(adsAmount: number): number {
    const base = verticalFov(this.settings.fov);
    const zoom = 1 + (this.heldZoom() - 1) * adsAmount;
    const sprint = 1 + (FEEL.sprintFovMultiplier - 1) * this.sprintFov.value;
    const slide = 1 + (FEEL.slideFovMultiplier - 1) * this.slideFx.value * (1 - adsAmount);
    const jet = 1 + (this.jet.fovScale - 1) * (1 - adsAmount);
    const t = Math.tan((base * Math.PI) / 360) / zoom;
    return ((2 * Math.atan(t) * 180) / Math.PI) * sprint * slide * jet;
  }

  /**
   * FOV-matched sensitivity while zoomed: the same mouse movement moves the crosshair the same
   * screen distance, then scaled by the player's ADS multiplier.
   */
  private zoomSensScale(): number {
    const ads = heldGun(this.player)?.adsAmount ?? 0;
    if (ads <= 0) return 1;
    const base = Math.tan((verticalFov(this.settings.fov) * Math.PI) / 360);
    const zoomed = base / (1 + (this.heldZoom() - 1) * ads);
    return (zoomed / base) * lerp(1, this.settings.adsSensitivity, ads);
  }

  /**
   * Nearest spot to `near` where a standing capsule fits on the ground (spirals outward).
   * Used for the partner's spawn/respawn so it never starts inside geometry.
   */
  clearSpot(near: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    for (let ring = 0; ring < 12; ring++) {
      const steps = Math.max(1, ring * 8);
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = near.x + Math.cos(a) * ring * 1.5;
        const z = near.z + Math.sin(a) * ring * 1.5;
        // Probe from just above `near` so roofs don't count and tunnels (y < 0) work too.
        const hit = this.physics.castRay({ x, y: near.y + 2.5, z }, { x: 0, y: -1, z: 0 }, 6);
        if (!hit || hit.point.y > near.y + 1 || hit.point.y < near.y - 3) continue;
        const spot = { x, y: hit.point.y + 0.03, z };
        if (!this.physics.overlapsStatic(spot, PLAYER.standHeight)) return spot;
      }
    }
    return { ...near };
  }

  private targets(): HitTarget<string>[] {
    const t = this.online ? [] : dummyTargets(this.dummies);
    const p = this.partner;
    if (!this.online && p?.alive)
      t.push({
        id: 'sparring',
        shapes: humanoidHitboxes(p.state.move.pos, p.state.move.eyeHeight, p.state.view.yaw),
      });
    // Online: the other players where they are drawn (what the server rewinds to for this
    // shot). Only for the predicted hit marker; the damage is the server's.
    if (this.online) {
      for (const r of this.online.remotePlayers(this.frameLocalMs)) {
        if (r.pose.hp <= 0) continue;
        t.push({
          id: `${REMOTE}${r.id}`,
          shapes: humanoidHitboxes(
            { x: r.pose.x, y: r.pose.y, z: r.pose.z },
            r.pose.eye,
            r.pose.yaw,
          ),
        });
      }
    }
    return t;
  }

  private remoteDroneTargets(): HitTarget<string>[] {
    if (!this.online) return [];
    return this.online.remoteDrones(this.frameLocalMs).map((d) => ({
      id: `${REMOTE_DRONE}${d.owner}`,
      shapes: [{ kind: 'sphere', zone: 'torso', a: d.pos, b: d.pos, r: DRONE.radius }],
    }));
  }

  /** Damage the partner (any source). Returns true if it died. */
  private damagePartner(amount: number): boolean {
    const p = this.partner;
    if (!p?.alive) return false;
    p.state.health = Math.max(0, p.state.health - amount);
    this.partnerView.hitFlash();
    const dist = this.distanceTo(p.state.move.pos);
    if (p.state.health <= 0) {
      p.died();
      this.audio.death(voiceFor('partner'), dist, 'partner');
      return true;
    }
    this.audio.hurt(voiceFor('partner'), dist, 'partner');
    return false;
  }

  private heldZoom(): number {
    const slot = this.player.arsenal.slot;
    return isGun(slot) ? gunConfig(this.player.arsenal, slot).adsZoom : 1;
  }

  start(): void {
    this.renderer.setAnimationLoop((t) => this.frame(t));
    // Online, a person joins at their first Play (the menu, where the name is typed, is up
    // until then); scripted play has no menu, so it joins right away.
    if (this.opts.autotest) {
      this.onlineJoin?.start(this.settings.playerName);
      this.readyOnce();
    }
  }

  /**
   * Pause or resume the practice worker's match, and the session's timing with it (the draw
   * timeline holds, then server time continues from where it stopped: no extrapolation across
   * the pause, no inflated jitter buffer, view times that match the worker's sim).
   */
  private setPracticePaused(paused: boolean): void {
    const now = performance.now();
    if (paused) this.online?.pauseTiming(now);
    else this.online?.resumeTiming(now);
    this.opts.friendRoom?.send('pause', { paused });
  }

  /** Practice settings changed since launch (bots, difficulty, limits, radar). */
  private practiceChanged(): string[] {
    return this.practiceLaunch ? practiceChanges(this.settings, this.practiceLaunch) : [];
  }

  /** Menu › Restart practice: a fresh practice match with the menu's current settings. */
  private restartPractice(): void {
    const url = practiceRestartUrl(window.location.href, this.settings);
    void this.onlineLink.leave().then(() => window.location.replace(url));
  }

  /** Menu › Practice vs bots (or Leave practice): reload into (out of) a practice match. */
  private togglePractice(): void {
    const url = practiceUrl(window.location.href, this.opts.practice !== true);
    void this.onlineLink.leave().then(() => window.location.replace(url));
  }

  private openFriendLobby(): void {
    const url = new URL(window.location.href);
    url.searchParams.delete('practice');
    url.searchParams.delete('room');
    url.searchParams.delete('online');
    url.searchParams.set('lobby', 'create');
    url.searchParams.set('map', this.settings.map);
    url.searchParams.set('size', this.settings.mapSize);
    url.searchParams.set('radar', this.settings.radar);
    void this.onlineLink.leave().then(() => window.location.replace(url.toString()));
  }

  /** Join (or create) the match for this page's map, size and mode, as `name`. */
  private joinOnline(name: string): void {
    const session = this.online;
    if (!session) return;
    const s = this.settings;
    void connectOnline(
      session,
      this.onlineLink,
      resolveServerUrl(
        window.location.search,
        window.location,
        import.meta.env.VITE_SERVER_URL as string | undefined,
        import.meta.env.PROD,
      ),
      normalizeMatchOptions({
        map: s.map,
        size: s.mapSize,
        mode: s.matchMode,
        name,
        primary: s.primary,
      }),
    ).then((room) => {
      if (!room) return;
      this.onlineJoin?.attach(nameSender(room));
      this.chat?.attach(room);
      this.sendLoadout = (primary) => room.send('loadout', { primary } satisfies LoadoutMessage);
    });
  }

  /** The server placed us in the match: start this life at its spawn (the server's state). */
  private onWelcome(w: WelcomeMessage): void {
    const sized = (m: string, z: string): string => (m === 'range' ? 'full' : z);
    if (
      w.map !== this.mapChoice.map ||
      sized(w.map, w.size) !== sized(this.mapChoice.map, this.mapChoice.size)
    ) {
      // Rooms are matched by map and size, so this should never happen; never play on a map
      // other than the one the server simulates.
      this.online?.handleStatus({ state: 'offline', error: `server runs ${w.map}/${w.size}` });
      return;
    }
    if (w.settings) this.applyOnlineAuthority(w.settings);
    if (this.player.drone) this.landDrone();
    this.onlineSpottedIds.clear();
    const spawn = { x: w.spawn.x, y: w.spawn.y, z: w.spawn.z };
    placeBodyAt(this.body, spawn);
    this.player = createPlayerState(spawn, w.seed, w.mode, w.primary);
    this.player.view = { yaw: w.spawn.yaw, pitch: 0 };
    grantSpawnProtection(this.player); // as the server's new life (its snapshot corrects)
    this.prev = clonePlayerState(this.player);
    this.appliedMode = w.mode;
    this.overrides.force(this.settings, 'matchMode', w.mode);
    this.grenades = [];
    this.input.yaw = w.spawn.yaw;
    this.input.pitch = 0;
    this.applySettings();
    // Quick match: the page joins at the first Play, so the intro waits for this spawn.
    this.maybeStartIntro();
  }

  private applyOnlineAuthority(settings: FriendMatchSettings): void {
    if (this.opts.practice) {
      // The player's own match: their settings stay theirs (see `practiceLaunch`).
      this.overrides.force(this.settings, 'online', true);
      return;
    }
    this.onlineAuthority = settings;
    this.forceMatchSettings(settings);
    this.overrides.force(this.settings, 'online', true);
    this.mapChoice.radar = this.settings.radar;
  }

  /** The host's match settings, shown in the menu for this page but never saved as the player's. */
  private forceMatchSettings(settings: FriendMatchSettings): void {
    const s = this.settings;
    this.overrides.force(s, 'map', settings.map);
    this.overrides.force(s, 'mapSize', settings.size);
    this.overrides.force(s, 'matchMode', settings.mode);
    this.overrides.force(s, 'radar', matchRadarToGameRadar(settings.radar));
    this.overrides.force(s, 'weather', settings.weather);
  }

  private frame(nowMs: number): void {
    const now = nowMs / 1000;
    const dt = this.lastTime < 0 ? 0 : Math.min(0.25, now - this.lastTime);
    this.lastTime = now;
    this.lastFrameDt = dt;
    this.stepsThisFrame = 0;
    // Light frames (menu, or a GPU well inside the interval) reveal the display's refresh.
    this.refresh.push(dt * 1000, isLightFrame(this.paused, this.gpuTimer.median()));
    // One network time per frame, even with the sim paused (menu open): smoke keeps advancing.
    this.sampleFrameTime(performance.now());
    this.pollCinematicInput();
    if (this.online) {
      this.reconcileOnline();
      this.onlineCombat(this.online);
    }
    // Online but not in the match (joining, reconnecting, or failed): hold still (nothing done
    // meanwhile could reach the server, so nothing is simulated either). Offline for good, the
    // badge says why; Menu › Match › online off goes back to single-player.
    const held =
      (this.online !== null && this.online.status.state !== 'online') || this.introHolding;
    if (!this.paused && !held) {
      this.accumulator += dt;
      while (this.accumulator >= SIM_DT && this.stepsThisFrame < SIM.maxStepsPerFrame) {
        this.simStep();
        this.accumulator -= SIM_DT;
        this.stepsThisFrame++;
      }
      if (this.stepsThisFrame === SIM.maxStepsPerFrame) this.accumulator = 0; // drop time, don't spiral
    }
    this.online?.flush();
    this.menuRenderElapsed = Math.min(0.25, this.menuRenderElapsed + dt);
    if (!this.paused || this.opts.autotest || this.menuRenderElapsed >= 1 / 30) {
      const renderDt = this.menuRenderElapsed;
      this.menuRenderElapsed = 0;
      this.render(renderDt);
    }
  }

  /**
   * Online: adopt the server's state for the local player if the prediction was off (the
   * unacknowledged inputs are replayed on top of it inside `reconcile`).
   */
  private reconcileOnline(): void {
    const session = this.online;
    if (!session) return;
    const life = session.currentLife;
    const wasFlying = this.player.drone?.alive === true;
    const before = { ...this.player.move.pos };
    const r = session.reconcile(this.player, this.body, SIM_DT);
    if (!r?.corrected) return;
    this.player = r.state;
    this.tactical.drone = this.player.drone;
    this.tactical.droneCharges = this.player.droneCharges;
    const nowFlying = this.player.drone?.alive === true;
    if (!wasFlying && nowFlying) {
      this.savedView ??= { yaw: this.input.yaw, pitch: this.input.pitch };
      this.dronePrev = null;
      this.audio.droneStart();
      this.hud.banner(`RECON DRONE UP — anyone it sees shows on your radar`, 2);
    } else if (wasFlying && !nowFlying) {
      this.landDrone();
    }
    // The sim takes the server's state at once (prediction stays exact); only the view is
    // smoothed. A small correction glides out over ~100 ms: the drawn position stays where it
    // was (the previous step shifts with the body, the offset holds the difference and decays).
    // A big one (respawn, teleport, > 2 m) snaps.
    const after = this.player.move.pos;
    if (this.correction.correct(before, after, session.currentLife !== life) === 'snap') {
      this.prev = clonePlayerState(this.player);
    } else {
      const p = this.prev.move.pos;
      p.x += after.x - before.x;
      p.y += after.y - before.y;
      p.z += after.z - before.z;
      // Not a step up/down: the step smoothing must not absorb it a second time.
      if (this.lastFeetY !== null) this.lastFeetY += after.y - before.y;
    }
    if (session.currentLife !== life) {
      // The server respawned us: face where the new life faces (the spawn's heading, or the
      // replayed inputs'), or the next input would turn the body straight back. The old life's
      // flight ends with it (its saved body view, its smoothing); a drone the reconciled new life
      // already carries (a delayed respawn snapshot, replayed inputs) stays up — the server is
      // flying it — with the new body's view saved for the landing.
      const flight = this.player.drone?.alive ? this.player.drone : null;
      this.dronePrev = null;
      this.savedView = flight ? { yaw: this.player.view.yaw, pitch: this.player.view.pitch } : null;
      // Tactical intel is per life, like the kit (in place: see `respawn`).
      Object.assign(this.tactical, createTactical<string>());
      this.tactical.drone = this.player.drone;
      this.tactical.droneCharges = this.player.droneCharges;
      this.onlineSpottedIds.clear();
      this.input.yaw = flight ? flight.yaw : this.player.view.yaw;
      this.input.pitch = flight ? flight.pitch : this.player.view.pitch;
      this.prev = clonePlayerState(this.player);
      // A clean cut back to first person; the replay rings record again.
      this.director.respawned();
      this.replay.unfreeze();
    }
  }

  /**
   * The scoreboard's content: online (and practice) everyone in the roster with the server's
   * scores, the pings it measured (BOT for bots) and the match goal/clock; offline, this
   * player's own tally on the range.
   */
  private scoreboardView(): ScoreboardView {
    const session = this.online;
    const size = {
      market: 'Market',
      full: 'Plac Defilad',
      north: 'North half',
      south: 'South half',
    };
    const where = this.mapChoice.map === 'range' ? 'Test range' : size[this.mapChoice.size];
    const me = session?.id;
    if (!session || !me || !session.match) {
      return {
        title: `Free practice · ${where}`,
        goal: 'No limits',
        me: 'local',
        players: [
          {
            id: 'local',
            name: this.settings.playerName.trim() || 'You',
            kills: this.stats.kills,
            deaths: this.stats.deaths,
            bot: false,
            ping: null,
          },
        ],
      };
    }
    const m = session.match;
    const players = session.roster.map((r): ScoreboardPlayer => {
      const score = m.scores.find((s) => s.id === r.id);
      const ping = r.id === me ? (this.opts.practice ? null : session.rtt) : session.pings[r.id];
      return {
        id: r.id,
        name: r.name,
        kills: score?.kills ?? 0,
        deaths: score?.deaths ?? 0,
        bot: r.bot === true,
        ping: ping ?? null,
        ...(r.persona ? { persona: BOT.personalities[r.persona]?.label ?? r.persona } : {}),
        connected: r.connected,
      };
    });
    const goal =
      m.phase === 'ended'
        ? resultText(m, me, (id) => session.nameOf(id))
        : matchGoal(m, session.phaseSecondsLeft(performance.now()));
    const chat = this.chat;
    return {
      title: `${this.opts.practice ? 'Practice' : 'Free for all'} · ${where}`,
      goal,
      me,
      players,
      ...(chat
        ? {
            muted: new Set(players.filter((p) => chat.isMutedName(p.name)).map((p) => p.id)),
            muteKeys: true,
          }
        : {}),
    };
  }

  /**
   * Online combat as the server resolved it: hit confirms (markers, damage numbers, the score
   * line), damage taken and deaths, the kill feed, other players' shots and frags. The local
   * player's own shots were already drawn when predicted; health only ever comes from the
   * server (snapshots), never from these.
   */
  private onlineCombat(session: OnlineSession): void {
    const me = session.id;
    for (const event of session.takeDrops()) this.dropFeedback(event, me);
    const events = session.takeCombat();
    if (me) for (const e of events) this.onlineEvent(e, me, session);
    const phase = session.match?.phase ?? null;
    if (phase === 'ended' && this.lastPhase !== 'ended') {
      this.grenades = this.grenades.filter((g) => g.kind !== 'frag');
    }
    if (me && session.match && phase === 'ended' && this.lastPhase === 'playing') {
      this.hud.banner(
        resultText(session.match, me, (id) => session.nameOf(id)),
        6,
      );
      this.director.matchEnded();
    }
    if (phase === 'playing' && this.lastPhase === 'ended') this.director.matchStarted();
    this.lastPhase = phase;
    const mine = session.match?.scores.find((s) => s.id === me);
    if (mine) {
      this.stats.kills = mine.kills;
      this.stats.deaths = mine.deaths;
    }
  }

  private onlineEvent(e: CombatEvent, me: string, session: OnlineSession): void {
    const nameOf = (id: string): string => session.nameOf(id);
    switch (e.type) {
      case 'shot': {
        if (e.by === me) return; // predicted when fired
        this.effects.tracer(e.from, e.to);
        this.remoteShotAudioQueue.push(e.from, e.silent ? 'coil' : e.slot);
        // The server sends one endpoint per trigger pull (the first shotgun pellet). Recover
        // only a matching visible world contact: a wall behind a character must not flash.
        this.remoteImpactDir.set(e.to.x - e.from.x, e.to.y - e.from.y, e.to.z - e.from.z);
        const distance = this.remoteImpactDir.length();
        if (distance > 0.001) {
          this.remoteImpactDir.multiplyScalar(1 / distance);
          const endpointPrecision = 0.005;
          const contact = this.physics.castVisibleRay(
            e.from,
            this.remoteImpactDir,
            distance + endpointPrecision,
          );
          if (contact?.visible && Math.abs(contact.distance - distance) <= endpointPrecision) {
            this.effects.impact(contact.point, contact.normal, contact.surface);
          }
        }
        return;
      }
      case 'hit': {
        if (e.dmg > 0 && e.outcome !== 'parried' && e.outcome !== 'blocked') {
          const self = e.target === me;
          const voice = self ? this.myVoice : voiceFor(e.target);
          const dist = self ? 0 : this.distanceTo(e.at);
          if (e.killed) this.audio.death(voice, dist, e.target);
          else this.audio.hurt(voice, dist, e.target);
        }
        if (e.by === me && e.target !== me && e.outcome === 'protected') {
          // Spawn-protected target: nothing landed. The blocked marker (unless the shot's
          // prediction already showed one), no hit counted, no damage number.
          const gun = e.weapon === 'rifle' || e.weapon === 'sidearm';
          // Deduped only against a predicted *blocked* marker: a predicted hit marker (the
          // shimmer not drawn yet) is corrected by showing the blocked one.
          if (!(gun && this.takeOwnGunShotMarker(e) === 'blocked')) {
            this.hud.blockedMarker();
            this.audio.guardBlock(false);
          }
        } else if (e.by === me && e.target !== me) {
          // The server confirms damage and supplies any marker prediction did not show.
          this.stats.hits++;
          const gun = e.weapon === 'rifle' || e.weapon === 'sidearm';
          // Deduped only against a predicted *hit* marker: a predicted blocked one (protection
          // ended between the drawn snapshot and the server's resolve) gets the real marker.
          const predictedMarker = gun ? this.takeOwnGunShotMarker(e) === 'hit' : false;
          if (e.outcome === 'parried') {
            this.audio.parry();
            this.hud.banner('Parried — you are stunned', 1.2);
          } else if (e.outcome === 'blocked' || e.outcome === 'guardBroken') {
            this.audio.guardBlock(e.outcome === 'guardBroken');
          } else if (e.weapon === 'knife') this.audio.knifeHit(true);
          // Guns usually show a predicted marker as the shot leaves; if prediction had no target
          // yet, the authoritative confirm supplies the nonlethal marker.
          if (e.killed || (gun ? !predictedMarker : e.outcome !== 'parried')) {
            this.hud.hitmarker(e.zone, e.killed);
            this.audio.hitmarker(e.zone, e.killed);
          }
          if (this.settings.damageNumbers && e.dmg > 0) {
            this.hud.damageNumber(e.at, e.dmg, e.zone);
          }
        }
        if (e.target === me && e.outcome === 'protected') {
          // Our spawn protection held: no damage arrow, no hurt.
        } else if (e.target === me) {
          if (e.outcome === 'parried') {
            this.audio.parry();
            this.viewmodel.parry();
            this.hud.banner('Parry — counter now!', 1.2);
          } else if (e.outcome === 'blocked' || e.outcome === 'guardBroken') {
            this.audio.guardBlock(e.outcome === 'guardBroken');
            if (e.outcome === 'guardBroken') this.hud.banner('Guard broken', 1.2);
          } else if (e.weapon === 'knife') this.audio.knifeHit(true);
          if (e.dmg > 0) {
            this.hud.damage(e.dmg / PLAYER.maxHealth, e.from, this.camera);
            // Shot at during the intro: the camera goes straight back to the eyes.
            if (this.director.mode === 'intro') this.director.skip();
          }
          if (e.killed) this.onlineDeath(e, me, session);
        }
        if (e.killed) this.onlineBadge?.pushFeed(killLine(e, me, nameOf), e.target === me);
        return;
      }
      case 'nade': {
        // Every frag, including ours, flies from the server's release. Windup/throw animation
        // is predicted, but an unapplied input must never leave a phantom live frag.
        const kind = 'kind' in e && e.kind === 'smoke' ? 'smoke' : 'frag';
        const id = -e.id;
        const known = this.grenades.some((g) => g.id === id);
        this.grenades = this.grenades.filter((g) => g.id !== id);
        this.grenades.push({
          id,
          owner: 0,
          pos: { ...e.pos },
          vel: { ...e.vel },
          // Only `boom` explodes it; an expired local copy is removed quietly.
          fuse: e.fuse + 0.5,
          resting: e.resting ?? false,
          kind,
        });
        if (!known) this.effects.addGrenade(id);
        return;
      }
      case 'boom': {
        const kind = 'kind' in e && e.kind === 'smoke' ? 'smoke' : 'frag';
        const id = -e.id;
        this.grenades = this.grenades.filter((g) => g.id !== id);
        if (kind === 'smoke') this.audio.smokePop(this.distanceTo(e.pos));
        else this.blastFx(e.pos);
        return;
      }
      case 'vhit': {
        // Our round on a truck's armour: a small confirm (no number: armour, not a body).
        if (e.by === me) {
          this.hud.hitmarker('legs', false);
          this.audio.bulletImpact(this.distanceTo(e.at), 'metal');
        }
        return;
      }
      case 'vboom': {
        // A truck blew up: the blast, a heavier shake; its crew's deaths come as hits.
        this.blastFx(e.pos);
        this.shake.kick(Math.max(0, 1 - this.distanceTo(e.pos) / 40) * 14);
        if (e.by === me) this.hud.banner('TRUCK DESTROYED', 1.8);
        return;
      }
      case 'jammer':
        if (e.by === me) return; // predicted when fired
        this.jammerFx.pulse(e.at);
        this.audio.jammer();
        return;
    }
  }

  /** Scratch pose for drawing a tumbling prop. */
  private readonly propPose: PropPose = {
    pos: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
  };

  /**
   * Props trucks broke: changes come due on the remote players' timeline (at once for our own
   * truck's), tumbling ones are drawn from the snapshots' poses in their own instance slots.
   */
  private renderProps(): void {
    const sync = this.online?.props;
    if (!sync) return;
    const view = this.props;
    const drawMs = this.frameViewTime ?? Number.POSITIVE_INFINITY;
    for (const c of sync.takeDue(drawMs)) {
      if (c.k === 'reset') view?.resetPoses();
      else if (c.k === 'place') view?.setPose(c.id, c.pose);
      else {
        if (c.k === 'hide') view?.setPose(c.id, null);
        if (!c.quiet) this.propBurst(c.id, c.at, c.v ?? 0, c.k === 'hide');
      }
    }
    if (!view) return;
    for (const id of sync.tumbling())
      if (sync.pose(id, drawMs, this.propPose)) view.setPose(id, this.propPose);
  }

  /** A prop smashed (debris, louder) or knocked over: the existing impact effects by surface. */
  private propBurst(id: number, at: Vec3 | undefined, speed: number, smash: boolean): void {
    const inst = this.physics.prop(id);
    if (!inst) return;
    const surface = surfaceOfModel(inst.model);
    const p = at ?? inst.pos;
    const bursts = smash ? 4 : 2;
    for (let i = 0; i < bursts; i++) {
      const a = (i / bursts) * Math.PI * 2;
      this.effects.debris.burst(
        { x: p.x + Math.cos(a) * 0.2, y: p.y + 0.1 * i, z: p.z + Math.sin(a) * 0.2 },
        { x: Math.cos(a) * 0.5, y: 0.85, z: Math.sin(a) * 0.5 },
        surface,
      );
    }
    // A truck knocking props: the material, not a bullet (no crack, no ricochet).
    const d = this.distanceTo(p);
    this.audio.bulletImpact(d, surface, false);
    if (smash || speed > 6) this.audio.bulletImpact(d * 0.8, surface, false);
  }

  /** The trucks as drawn, by draw time (the kill cam's 4.5 s), per truck. */
  private readonly vehicleRing = new Map<number, { t: number; pose: VehiclePose }[]>();

  private recordVehicles(vt: number): void {
    for (const v of this.drawnVehicles) {
      let ring = this.vehicleRing.get(v.id);
      if (!ring) this.vehicleRing.set(v.id, (ring = []));
      const last = ring.at(-1);
      if (last && vt - last.t < 25) continue; // 40 Hz is plenty
      ring.push({ t: vt, pose: v });
      while (ring.length && vt - ring[0]!.t > 4500) ring.shift();
    }
  }

  /** The trucks as they were drawn at draw time `t` (blended between the ring's entries). */
  private replayedVehicles(t: number): VehiclePose[] {
    const out: VehiclePose[] = [];
    for (const ring of this.vehicleRing.values()) {
      const i = ring.findIndex((e) => e.t >= t);
      const b = i < 0 ? ring.at(-1) : ring[i];
      const a = i > 0 ? ring[i - 1] : b;
      if (!a || !b) continue;
      const k = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
      out.push({
        ...b.pose,
        motion:
          a.pose.condition === b.pose.condition
            ? lerpMotion(a.pose.motion, b.pose.motion, k)
            : (k < 0.5 ? a : b).pose.motion,
      });
    }
    return out;
  }

  /** Which truck a hit target (a remote player as drawn) rides in, if any. */
  private crewOf(targetId: string): number | undefined {
    if (!this.online || !targetId.startsWith(REMOTE)) return undefined;
    const id = targetId.slice(REMOTE.length);
    const r = this.online.remotePlayers(this.frameLocalMs).find((q) => q.id === id);
    return seatFromWire(r?.pose.vh)?.vehicle;
  }

  /**
   * The camera in a truck. The driver: a third-person chase camera behind the truck as
   * predicted (interpolated between sim steps), orbiting with the mouse, pulled in off walls.
   * A passenger: first person at its seat's eye in the truck as drawn (the same place its shots
   * leave from).
   */
  private seatCamera(seat: SeatState, a: number, dt: number): void {
    if (seat.seat === 'driver' && seat.motion) {
      const cur = seat.motion;
      const old = this.prev.seat?.motion ?? cur;
      const pivot = {
        x: lerp(old.pos.x, cur.pos.x, a),
        y: lerp(old.pos.y, cur.pos.y, a) + CHASE.height,
        z: lerp(old.pos.z, cur.pos.z, a),
      };
      // Free look with the mouse; left alone while moving, the view swings back behind the truck.
      const speed = Math.hypot(cur.vel.x, cur.vel.z);
      if (performance.now() - this.input.lastLookMs > CHASE.recentreAfterMs && speed > 2) {
        const behind = cur.yaw + Math.PI;
        const d = Math.atan2(Math.sin(behind - this.input.yaw), Math.cos(behind - this.input.yaw));
        const step = CHASE.recentreRate * dt * Math.min(1, speed / 8);
        this.input.yaw += Math.max(-step, Math.min(step, d));
        this.input.pitch += (CHASE.restPitch - this.input.pitch) * Math.min(1, dt * 2);
      }
      const yaw = this.input.yaw;
      const pitch = Math.max(-0.5, Math.min(0.9, this.input.pitch + CHASE.tilt));
      // Tree crowns have no collider: step to a closer, higher framing when one is in the way
      // (walls and trunks: the camera collision, as for the cinematic cameras).
      const crowns = crownsNear(
        this.chaseCrowns,
        pivot,
        CHASE_FRAMINGS[0]!.distance + 2,
        this.chaseNear,
      );
      const wall = (p: typeof pivot, w: typeof pivot): number =>
        collideCamera(p, w, this.shot.cast, this.chaseHit);
      this.framing.update(pickFraming(pivot, yaw, pitch, crowns, wall), dt);
      framingPoint(pivot, yaw, pitch, this.framing.distance, this.framing.lift, this.chaseWant);
      const wanted = Math.hypot(
        this.chaseWant.x - pivot.x,
        this.chaseWant.y - pivot.y,
        this.chaseWant.z - pivot.z,
      );
      // Never inside or behind the leaves: kept short of the first crown, like a wall.
      const free = Math.min(
        wall(pivot, this.chaseWant),
        wanted * crownClear(pivot, this.chaseWant, crowns),
      );
      const use = this.chase.update(free, wanted, dt);
      const k = wanted > 1e-5 ? use / wanted : 0;
      this.camera.position.set(
        pivot.x + (this.chaseWant.x - pivot.x) * k,
        pivot.y + (this.chaseWant.y - pivot.y) * k,
        pivot.z + (this.chaseWant.z - pivot.z) * k,
      );
      // Leaves still between the camera and the truck (it's parked under a tree) dither out.
      pivot.y -= CHASE.fadeDrop;
      setTreeFade(this.camera.position, pivot, CHASE.fadeRadius);
      return;
    }
    this.chase.reset();
    this.framing.reset();
    const eye = seatEyeOf(this.drawnVehicles, seat);
    if (eye) this.camera.position.set(eye.x, eye.y, eye.z);
  }

  /**
   * Place the trucks (ours, at the wheel, from the prediction; the rest as drawn), their engines,
   * and the seat HUD / get-in prompt. A seat change plays the door and a quick blink.
   */
  /**
   * The trucks for this frame's client queries (frag flight, name-tag sight): sampled at the
   * frame's network time (fresh, not the last render's), with the truck we drive where our
   * prediction has it, as `renderVehicles` draws it.
   */
  private queryVehicles(): VehiclePose[] {
    if (!this.online) return [];
    const seat = this.player.health > 0 ? this.player.seat : null;
    return withOwnTruck(this.online.vehicles(this.frameLocalMs), seat, seat?.motion);
  }

  private renderVehicles(dt: number, a: number): void {
    this.truckPromptVisible = false;
    const view = this.vehiclesView;
    const session = this.online;
    if (!view) return;
    if (!session) {
      // Offline: only the tyre demo's ghost (its view is built on demand by `tyreDemo`).
      view.tyres.setView(window.innerHeight, this.quality === 'low');
      view.tyres.setSmoke(this.camera.position, this.visibleSmoke);
      const ghost = this.stepTyreDemo(dt);
      this.tyreDemoList.length = 0;
      if (ghost) this.tyreDemoList.push(ghost);
      view.update(dt, this.tyreDemoList);
      return;
    }
    const seat = this.player.health > 0 ? this.player.seat : null;
    // The kill cam replays the trucks too (a run-over replays with its truck), from a short ring
    // of the poses drawn on the same timeline as the players' rings; frozen while it plays.
    const t = this.replayMs();
    const replaying = this.director.mode === 'killcam' && Number.isFinite(t);
    const vt = this.frameViewTime;
    if (!replaying && vt !== undefined) this.recordVehicles(vt);
    const source = replaying ? this.replayedVehicles(t) : this.drawnVehicles;
    const list: DrawnVehicle[] = source.map((v) => {
      if (replaying) {
        return {
          id: v.id,
          motion: v.motion,
          condition: v.condition,
          health: v.hp / VEHICLE.maxHealth,
        };
      }
      if (seat?.seat === 'driver' && seat.vehicle === v.id && seat.motion) {
        const cur = seat.motion;
        const old = this.prev.seat?.motion ?? cur;
        return {
          id: v.id,
          motion: lerpMotion(old, cur, a),
          condition: v.condition,
          health: v.hp / VEHICLE.maxHealth,
        };
      }
      return {
        id: v.id,
        motion: v.motion,
        condition: v.condition,
        health: v.hp / VEHICLE.maxHealth,
      };
    });
    view.tyres.setView(window.innerHeight, this.quality === 'low');
    view.tyres.setSmoke(this.camera.position, this.visibleSmoke);
    const ghost = this.stepTyreDemo(dt);
    view.update(dt, ghost ? [...list, ghost] : list, !replaying);
    // Engines: pitch by speed (and our throttle at the wheel), loudness by distance.
    list.forEach((v, i) => {
      const m = v.motion;
      const speed = Math.hypot(m.vel.x, m.vel.z);
      const mine = seat?.vehicle === v.id;
      const throttle = mine && seat?.seat === 'driver' ? Math.abs(this.lastMoveZ) : 0;
      const d = this.distanceTo(m.pos);
      const level = v.condition === 'active' ? Math.max(0, 1 - d / 70) * (mine ? 1 : 0.8) : 0;
      this.audio.setEngine(i, level, Math.min(1, speed / VEHICLE.topSpeed + throttle * 0.25));
    });
    // Seat changes: the door, a blink, a word on the HUD.
    const key = seat ? `${seat.vehicle}:${seat.seat}` : null;
    if (key !== this.seatKeyLast) {
      if (this.seatKeyLast !== null || key !== null) this.audio.vehicleDoor(0);
      if (key && seat) this.hud.banner(`IN THE TRUCK — ${SEAT_LABEL[seat.seat]}`, 1.4);
      this.seatKeyLast = key;
    }
    // On foot near a truck with a free seat: the prompt (the seat you'd get).
    let prompt: string | null = null;
    if (!seat && session.dropTruckPriority(this.player, this.physics)) {
      const taken = new Map<number, Set<SeatId>>();
      for (const r of session.remotePlayers(this.frameLocalMs)) {
        const s = seatFromWire(r.pose.vh);
        if (!s || r.pose.hp <= 0) continue;
        const set = taken.get(s.vehicle) ?? new Set<SeatId>();
        set.add(s.seat);
        taken.set(s.vehicle, set);
      }
      for (const v of list) {
        if (v.condition !== 'active') continue;
        const pick = chooseSeat(
          v.motion,
          taken.get(v.id) ?? new Set(),
          this.player.move.pos,
          this.physics,
        );
        if (!pick) continue;
        prompt = `${this.keyFor('interact')}  ${pick === 'driver' ? 'DRIVE' : `RIDE · ${SEAT_LABEL[pick]}`}`;
        break;
      }
    }
    this.truckPromptVisible = prompt !== null;
    const mineV = seat ? list.find((v) => v.id === seat.vehicle) : undefined;
    this.vehicleHud?.update(
      {
        seat: seat?.seat ?? null,
        health: mineV?.health ?? 0,
        outOfArc:
          seat !== null &&
          mineV !== undefined &&
          !inFireArc(seat.seat, this.input.yaw, mineV.motion.yaw) &&
          seat.seat === 'front',
        prompt,
      },
      { interact: this.keyFor('interact'), switchSeat: this.keyFor('switchSeat') },
    );
  }

  private recordOnlineShotMarker(seq: number, predicted: PredictedMarker): void {
    this.onlineShotMarkers.set(seq, predicted);
    while (this.onlineShotMarkers.size > MAX_ONLINE_SHOT_MARKERS) {
      const oldest = this.onlineShotMarkers.keys().next().value;
      if (oldest === undefined) break;
      this.onlineShotMarkers.delete(oldest);
    }
  }

  /** The marker the confirmed shot's prediction showed (null: none), consumed. */
  private takeOwnGunShotMarker(e: Extract<CombatEvent, { type: 'hit' }>): PredictedMarker {
    if (e.seq === undefined) return null;
    const had = this.onlineShotMarkers.get(e.seq) ?? null;
    this.onlineShotMarkers.delete(e.seq);
    return had;
  }

  /** A blast's sight, sound and shake (no damage: the caller decides that). */
  private blastFx(c: { x: number; y: number; z: number }): number {
    const dist = this.distanceTo(c);
    this.effects.explosion(c, this.blastContact(c));
    this.blastAudioQueue.push(c);
    this.shake.kick(Math.max(0, 1 - dist / 25) * 9);
    return dist;
  }

  private blastContact(c: Vec3): ExplosionContact | undefined {
    const hit = this.physics.castGroundRay(
      { x: c.x, y: c.y + 0.35, z: c.z },
      { x: 0, y: -1, z: 0 },
      1.2,
    );
    return hit?.visible
      ? { point: hit.point, normal: hit.normal, surface: hit.surface ?? 'stone' }
      : undefined;
  }

  /** Current predicted drops online/practice; local simulation in the offline range. */
  drops(): readonly WeaponDropState[] {
    return this.online?.drops ?? this.weaponDrops.drops;
  }

  /** Autotest only; online/practice goes through the authoritative match's validated hook. */
  dropGun(primary: PrimaryId, x: number, z: number, ammoFraction: number): void {
    if (!this.opts.autotest && !import.meta.env.DEV) return;
    if (!Object.hasOwn(PRIMARIES, primary) || ![x, z, ammoFraction].every(Number.isFinite)) return;
    if (ammoFraction <= 0 || ammoFraction > 1) return;
    if (this.online) {
      this.online.dropGun(primary, x, z, ammoFraction);
      return;
    }
    const pos = this.castDown({ x, y: this.player.move.pos.y, z });
    spawnDrop(this.weaponDrops, primary, pos, ammoFraction, pos.y, this.player.arsenal.mode);
  }

  private dropFeedback(event: WeaponDropEvent, me: string | null): void {
    if ((event.type !== 'ammo' && event.type !== 'swap') || event.by !== me) return;
    this.audio.pickupCharge();
    this.hud.banner(
      event.type === 'ammo' ? `+${event.amount} ammo` : PRIMARIES[event.primary].name,
      1.4,
    );
  }

  /** The last step's forward stick (the engine note follows the throttle). */
  private lastMoveZ = 0;

  /** One fixed 60 Hz simulation step. */
  private simStep(): void {
    this.prev = clonePlayerState(this.player);
    const sampled = this.input.sample(this.seq++);
    this.lastMoveZ = sampled.moveZ;
    // Online: predict with exactly what the server will step (it sanitizes every input).
    const input = this.online ? sanitizeInput(sampled) : sampled;
    const t = this.tactical;
    // The dead (offline death cam wait) call in nothing.
    const tacButtons = this.player.health > 0 ? input.buttons : 0;
    const beforeDrone = this.player.drone?.alive === true;
    if (beforeDrone && this.player.drone) this.dronePrev = { ...this.player.drone.pos };
    const droneWorld = {
      castRay: (origin: Vec3, dir: Vec3, maxDistance: number) =>
        this.physics.castGroundRay(origin, dir, maxDistance),
    };
    const previousButtons = this.player.prevButtons;
    const events = stepPlayerInCrowd(
      this.player,
      input,
      SIM_DT,
      this.body,
      this.localCrowd(),
      this.online?.id ?? 'local',
      // Trucks (online/practice: the server's, as of the newest snapshot, like the crowd).
      this.online?.vehicleEnv(droneWorld) ?? { droneWorld },
    );
    // A passenger's feet follow its seat in the truck as drawn (not predicted: never compared).
    this.online?.followSeat(this.player, this.frameLocalMs);
    if (!this.online) observeDropOwners(this.weaponDrops, [{ id: 'player', player: this.player }]);
    t.drone = this.player.drone;
    t.droneCharges = this.player.droneCharges;
    const piloting = this.player.drone?.alive === true;
    if (!this.online && piloting && this.player.drone && this.seq % 6 === 0) {
      // Spot a few times a second: chest points of everyone else.
      const targets = [
        ...this.dummies
          .filter((d) => d.health > 0)
          .map((d) => ({ id: d.def.id, pos: { x: d.pos.x, y: d.pos.y + 1.2, z: d.pos.z } })),
        ...(this.partner?.alive ? [{ id: 'partner', pos: eyePosition(this.partner.state) }] : []),
      ];
      const fresh = markSpotted(
        t,
        droneSpots(this.player.drone, targets, this.physics, this.smoke, this.foliage),
      );
      if (fresh.length) this.audio.spotPing();
    }
    if (!this.online) stepTactical(t, SIM_DT);
    // A spot mark belongs to one life: a target that dies loses it (its respawn isn't spotted).
    if (!this.online) {
      t.spotted = t.spotted.filter((m) =>
        m.id === 'partner'
          ? this.partner?.alive === true
          : this.dummies.some((d) => d.def.id === m.id && d.health > 0),
      );
      this.smoke = stepSmoke(this.smoke, SIM_DT);
    }
    // Present this step's shot with the gun that fired it, before an E swap changes the primary.
    for (const e of events) this.handleEvent(e, input.seq);
    this.online?.predictDrops(this.player, input, previousButtons, SIM_DT, this.physics);
    // Record the full predicted state, including the new primary and ammunition.
    this.online?.recordStep(input, this.player, this.frameViewTime);
    let offlineSwapped = false;
    if (!this.online && pressed(input.buttons, previousButtons, Button.Interact)) {
      const swaps = swapWithDrop(this.weaponDrops, {
        id: 'player',
        player: this.player,
        groundY: this.castDown(this.player.move.pos).y,
      });
      offlineSwapped = swaps.some((event) => event.type === 'swap');
      for (const event of swaps) this.dropFeedback(event, 'player');
    }
    stepDummies(this.dummies, SIM_DT);
    if (this.partner) this.stepPartner(this.partner);
    // Radar: call in a stored charge (T); uplinks give charges. Nobody shows unless you call it.
    if (!this.online && stepRadar(t.radar, tacButtons, this.tacPrevButtons, SIM_DT)) {
      this.audio.radarUplink();
      this.hud.banner(`RADAR CALLED IN — everyone visible for ${RADAR.duration} s`, 2);
    }
    this.tacPrevButtons = tacButtons;
    // Only the player collects: the sparring partner has no tactical kit to use a charge with
    // (M3 bots get the full kit and join here).
    if (!this.online) {
      const collectors = [
        {
          id: 'player',
          pos: this.player.move.pos,
          alive: this.player.health > 0,
          takes: (kind: PickupKind) =>
            kind === 'medkit' ? this.player.health < PLAYER.maxHealth : takesPickup(t, kind),
        },
      ];
      if (this.board) {
        stepBoard(this.board, [
          {
            id: 'player',
            pos: this.player.move.pos,
            alive: this.player.health > 0,
            prone: this.player.move.prone,
            eligible: this.player.move.jet === 0,
          },
        ]);
        this.player.move.board = this.board.rider === 'player';
      }
      if (this.jetpacks.length) {
        const m = this.player.move;
        const holder = {
          id: 'player',
          pos: m.pos,
          alive: this.player.health > 0,
          jet: m.jet,
          eligible: !m.board && !m.prone,
        };
        for (const e of stepJetpacks(this.jetpacks, [holder], this.castDown))
          if (e.type === 'pickup') grantJetpack(m);
      }
      for (const e of stepPickups(this.pickups, collectors, SIM_DT)) {
        if (e.by !== 'player') continue;
        if (e.kind === 'medkit') {
          this.player.health = healWithMedkit(this.player.health);
          continue; // the heal cue plays on the health rise (online too)
        }
        if (e.kind === 'drone') {
          this.player.droneCharges = Math.min(1, this.player.droneCharges + 1);
          t.droneCharges = this.player.droneCharges;
        } else {
          grantPickup(t, e.kind);
        }
        this.audio.pickupCharge();
        this.hud.banner(
          e.kind === 'radar'
            ? `RADAR CHARGE — press ${this.keyFor('radar')} to call it in`
            : `DRONE CHARGE — press ${this.keyFor('drone')} to launch the recon drone`,
          2.5,
        );
      }
    }
    if (!this.online) {
      for (const event of stepDrops(
        this.weaponDrops,
        [{ id: 'player', player: this.player, skipAuto: offlineSwapped }],
        SIM_DT,
      ))
        this.dropFeedback(event, 'player');
    }
    // Frags bounce off the trucks as on the server (its flight is the authority): this step's
    // trucks (not last frame's), ours where our prediction has it.
    const trucks = this.queryVehicles();
    const flight = trucks.length ? withTrucks(this.physics, trucks) : this.physics;
    for (const g of this.grenades) {
      const r = stepGrenade(g, SIM_DT, flight);
      if (r.bounceSpeed > 1.5) this.audio.grenadeBounce(r.bounceSpeed, this.distanceTo(g.pos));
      if (!this.online && r.exploded) {
        if (g.kind === 'smoke') this.popSmoke(g);
        else this.explode(g);
      }
    }
    this.grenades = this.grenades.filter((g) => g.fuse > 0);
    // Safety net: never fall forever (online, the server respawns you and the snapshot says so).
    if (!this.online && this.player.move.pos.y < -20) this.respawn();
    // Offline death cam: the respawn comes after the online delay (or at the next press).
    if (this.respawnTimer > 0) {
      this.respawnTimer -= SIM_DT;
      if (this.respawnTimer <= 0) this.respawn();
    }
  }

  /**
   * Player collision for the local player's step: online, the others at their newest snapshots
   * (the server resolves the same step against where they are); offline, the living range
   * dummies (immovable: they don't step) and the sparring partner.
   */
  private localCrowd(): readonly CrowdMember[] {
    if (this.online) return this.online.crowd();
    const out = this.offlineCrowd;
    let n = 0;
    for (const d of this.dummies) {
      if (d.health <= 0) continue;
      const e = (out[n++] ??= { id: '', x: 0, y: 0, z: 0, height: 0 });
      e.id = d.def.id;
      e.x = d.pos.x;
      e.y = d.pos.y;
      e.z = d.pos.z;
      e.height = crowdHeight(d.def.crouched ?? false, false);
    }
    const partner = this.partner;
    if (partner?.alive)
      crowdMemberOf(
        'partner',
        partner.state.move,
        (out[n++] ??= { id: '', x: 0, y: 0, z: 0, height: 0 }),
      );
    out.length = n;
    return out;
  }

  private stepPartner(partner: SparringPartner): void {
    const crowd = this.player.health > 0 ? this.partnerCrowd : undefined;
    if (crowd) crowdMemberOf('local', this.player.move, this.partnerCrowd[0]!);
    const sees =
      partner.alive &&
      sightVisibility(
        partner.eye(),
        eyePosition(this.player),
        this.physics,
        this.smoke,
        this.foliage,
      ) >= SIGHT_THRESHOLD;
    for (const e of partner.step(SIM_DT, this.player, this.player.health > 0, sees, crowd)) {
      if (e.type === 'meleeStart') {
        // The cue is the tell, so only the opening chamber gets it (not fast follow-ups).
        if (isOpeningWindup(partner.state.arsenal.melee.windupTotal)) {
          this.audio.chamberCue(this.distanceTo(partner.state.move.pos));
        }
      } else if (e.type === 'melee') {
        const me = this.player.move;
        const r = resolveMelee(
          partner.eye(),
          e.yaw,
          e.pitch,
          this.physics,
          [
            {
              id: 'player',
              shapes: humanoidHitboxes(me.pos, me.eyeHeight, this.player.view.yaw),
            },
          ],
          e.move,
        );
        if (r.kind !== 'target') continue;
        // Spawn-protected: the blade meets nothing (no parry, no guard wear, no damage).
        if (isSpawnProtected(this.player)) continue;
        const res = applyKnifeStrike(partner.state, this.player, e.move);
        const from = partner.state.move.pos;
        if (res.outcome === 'parried') {
          this.audio.parry();
          this.viewmodel.parry();
          this.hud.banner('Parry — counter now!', 1.2);
        } else if (res.outcome === 'blocked' || res.outcome === 'guardBroken') {
          const broken = res.outcome === 'guardBroken';
          this.audio.guardBlock(broken);
          if (broken) this.hud.banner('Guard broken', 1.2);
          this.damagePlayer(res.damage, from, 'Your sparring partner got you', 'partner');
        } else {
          this.audio.knifeHit(true);
          this.damagePlayer(res.damage, from, 'Your sparring partner got you', 'partner');
        }
      }
    }
  }

  /**
   * Single-player spawn choice. With the sparring partner alive (the only enemy offline;
   * dummies don't count), the server's rule: the spawn safest from it (out of its sight, then
   * farthest; `pickSafeSpawn`). Otherwise a random one away from where you died.
   */
  private pickSpawn(): SpawnPoint {
    if (this.spawns.length === 1) return this.spawns[0]!;
    if (this.partner?.alive) return pickSafeSpawn(this.spawns, [this.partner.eye()], this.physics);
    const here = this.player.move.pos;
    const far = this.spawns.filter((s) => Math.hypot(s.pos.x - here.x, s.pos.z - here.z) > 40);
    const pool = far.length ? far : this.spawns;
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

  /**
   * The first offline life is spawn-protected like every later one. Granted before play: the
   * sim is paused until Play, so the 2 s start counting when the player enters the game. Online
   * the server hands out lives (the welcome grants it).
   */
  private startOfflineLife(): void {
    if (!this.online) grantSpawnProtection(this.player);
  }

  private respawn(): void {
    clearDropOwner(this.weaponDrops.drops, 'player');
    this.respawnTimer = 0;
    this.director.respawned();
    if (this.player.drone) this.landDrone();
    // A new life never keeps the skateboard (it lies where we fell).
    if (this.board?.rider === 'player') this.board.rider = null;
    // …nor a jetpack (an unlit one drops where we fell; a lit one is spent).
    jetpackRespawned(this.jetpacks, 'player', this.jetHomes, this.castDown);
    const spawn = this.pickSpawn();
    // At the spawn first: dying prone under a low ceiling can't stand up where we fell.
    if (!placeBodyAt(this.body, spawn.pos) || this.body.capsuleHeight !== PLAYER.standHeight) {
      console.warn(`respawn: capsule ${this.body.capsuleHeight} m at a spawn, not standing`);
    }
    this.player = createPlayerState(
      spawn.pos,
      this.player.seed,
      this.settings.matchMode,
      this.settings.primary,
    );
    grantSpawnProtection(this.player); // the same rule as online (sim/spawnProtection.ts)
    this.prev = clonePlayerState(this.player);
    // Tactical intel is per life, like the kit: charges, live radar, jams and spots all reset.
    // Reset in place: simStep holds a reference to this object for the rest of the step.
    Object.assign(this.tactical, createTactical<string>());
    this.input.yaw = spawn.yaw;
    this.input.pitch = 0;
  }

  private distanceTo(p: { x: number; y: number; z: number }): number {
    const e = eyePosition(this.player);
    return Math.hypot(p.x - e.x, p.y - e.y, p.z - e.z);
  }

  /** Smoke grenade pops: a cloud blooms where it lies. */
  private popSmoke(g: GrenadeState): void {
    // Pops mid-air on a steep throw: the cloud settles onto the surface below (≤ 30 m).
    const down = this.physics.castRay(g.pos, { x: 0, y: -1, z: 0 }, 30);
    const pos = down ? { ...down.point } : { ...g.pos };
    this.smoke.push({ id: this.nextSmokeId++, pos, age: 0 });
    this.audio.smokePop(this.distanceTo(g.pos));
  }

  /** End of a drone flight (recalled, battery, shot down): back to your eyes. */
  private landDrone(): void {
    this.player.drone = null;
    this.tactical.drone = null;
    this.dronePrev = null;
    if (this.savedView) {
      this.input.yaw = this.savedView.yaw;
      this.input.pitch = this.savedView.pitch;
    }
    this.savedView = null;
    this.audio.droneStop();
  }

  private explode(g: GrenadeState): void {
    const c = g.pos;
    const dist = this.blastFx(c);
    if (this.online) return; // damage and kill stats only arrive from the server
    // Dummies: centre of mass.
    for (const d of this.dummies) {
      if (d.health <= 0) continue;
      const dmg = explosionDamage(c, { x: d.pos.x, y: d.pos.y + 1.1, z: d.pos.z }, this.physics);
      if (dmg <= 0) continue;
      const killed = damageDummy(d, dmg);
      this.stats.hits++;
      if (killed) this.stats.kills++;
      this.dummyView.flash(d.def.id);
      this.hud.hitmarker('torso', killed);
      if (this.settings.damageNumbers)
        this.hud.damageNumber({ x: d.pos.x, y: d.pos.y + 1.6, z: d.pos.z }, dmg, 'torso');
    }
    // The thrower too: frags don't care whose they are.
    const m = this.player.move;
    const selfDmg = explosionDamage(
      c,
      { x: m.pos.x, y: m.pos.y + m.eyeHeight * 0.65, z: m.pos.z },
      this.physics,
    );
    this.lastExplosion = { pos: { ...c }, distance: dist, selfDamage: selfDmg };
    if (selfDmg > 0) this.damagePlayer(selfDmg, c);
    const partner = this.partner;
    if (partner?.alive) {
      const pp = partner.state.move.pos;
      const pd = explosionDamage(c, { x: pp.x, y: pp.y + 1.1, z: pp.z }, this.physics);
      if (pd > 0) {
        const killed = this.damagePartner(pd);
        this.stats.hits++;
        this.hud.hitmarker('torso', killed);
        if (killed) this.stats.kills++;
      }
    }
  }

  private damagePlayer(
    amount: number,
    from: { x: number; y: number; z: number },
    cause = 'You were killed by your own grenade',
    killer: 'partner' | null = null,
  ): void {
    const p = this.player;
    // Online, health is the server's: damage arrives in snapshots (and `hit` events for the
    // arrow). Local practice targets and the predicted blast of your own frag never hurt you
    // here; the server's blast does, through the same path. The dead take no more damage.
    if (amount <= 0 || this.online || p.health <= 0) return;
    if (isSpawnProtected(p)) return; // spawn protection: nothing lands (one's own frag too)
    if (this.director.mode === 'intro') this.director.skip();
    p.health = Math.max(0, p.health - amount);
    this.hud.damage(amount / PLAYER.maxHealth, from, this.camera);
    if (p.health > 0) this.audio.hurt(this.myVoice, 0, 'self');
    else this.audio.death(this.myVoice, 0, 'self');
    if (p.health <= 0) {
      clearDropOwner(this.weaponDrops.drops, 'player');
      spawnDeathDrop(this.weaponDrops, p, this.castDown(p.move.pos).y);
      this.stats.deaths++;
      this.hud.banner(cause);
      if (!this.offlineDeathCam(killer, from)) this.respawn();
    }
  }

  /**
   * Offline death with the camera moments on: the death cam (and the partner's kill cam) run
   * while the respawn waits the online delay — any press respawns at once, so practice never
   * waits on the camera. False when the moments are off (respawn now, as before).
   */
  private offlineDeathCam(killer: 'partner' | null, from: { x: number; y: number; z: number }) {
    if (!this.director.enabled) return false;
    if (this.player.drone) this.landDrone();
    this.director.died({
      killer,
      killerName: killer ? 'Sparring partner' : 'Your own frag',
      weapon: killer ? KNIFE.name : GRENADE.name,
      distance: this.distanceTo(from),
      headshot: false,
      killMs: Number.NaN,
    });
    this.respawnTimer = MATCH.respawnDelay;
    return true;
  }

  /** Online: the server killed us — the death cam, the kill cam from the killer's shoulder. */
  private onlineDeath(
    e: Extract<CombatEvent, { type: 'hit' }>,
    me: string,
    session: OnlineSession,
  ) {
    const killer = e.by && e.by !== me ? e.by : null;
    // The clock is fitted to arrivals: an event sent at server time T lands at `now` ≈ T.
    const now = session.serverNow(this.frameLocalMs);
    const killMs = now ?? Number.NaN;
    let weapon: string =
      e.weapon === 'sidearm'
        ? SIDEARM.name
        : e.weapon === 'knife'
          ? KNIFE.name
          : e.weapon === 'truck'
            ? 'Run over (truck)'
            : e.weapon === 'wreck'
              ? 'Truck explosion'
              : GRENADE.name;
    if (e.weapon === 'rifle') {
      const ring = killer ? this.replay.ringOf(killer) : null;
      const primary = ring?.sample(ring.newest, this.scratchPose) ? this.scratchPose.primary : null;
      weapon = primary ? PRIMARIES[primary].name : 'Rifle';
    }
    const info: KillInfo = {
      killer,
      killerName: killer
        ? session.nameOf(killer)
        : e.weapon === 'truck' || e.weapon === 'wreck'
          ? 'A runaway truck'
          : 'Your own frag',
      weapon,
      distance: Math.hypot(e.from.x - e.at.x, e.from.y - e.at.y, e.from.z - e.at.z),
      headshot:
        e.zone === 'head' && e.weapon !== 'frag' && e.weapon !== 'truck' && e.weapon !== 'wreck',
      killMs,
    };
    this.director.died(info);
    this.deathLife = session.currentLife;
    this.aliveInDeath = 0;
    const cam = this.director.deathShot;
    // The replay window is complete a moment after the blow: keep it while it plays.
    if (cam && Number.isFinite(killMs)) this.replay.freeze(killMs + CINE.killcamPostRoll * 1000);
    // The kill-cam card says who and with what; without it, the banner does.
    if (!(cam && killer)) {
      this.hud.banner(
        deathBanner(e, (id) => session.nameOf(id)),
        MATCH.respawnDelay,
      );
    }
  }

  private handleEvent(e: PlayerEvent, inputSeq?: number): void {
    switch (e.type) {
      case 'shot':
        this.fireShot(e.shot, inputSeq);
        break;
      case 'chargeStart':
        this.audio.coilCharge(e.time);
        break;
      case 'dryFire':
        this.audio.dryFire();
        break;
      case 'reloadStart':
        // Scanned guns play their foley at the clip's keyframes (Viewmodel.onCue → foley);
        // the fitted recording only covers guns without an authored reload.
        if (!this.viewmodel.hasReloadClip(this.player.arsenal.slot))
          this.audio.reload(
            e.duration,
            e.empty,
            this.player.arsenal.slot === 'sidearm' ? 'sidearm' : 'rifle',
          );
        break;
      case 'reloadEnd':
        break;
      case 'overheat':
        this.audio.overheat();
        this.hud.banner('OVERHEATED — venting', e.lockout);
        break;
      case 'jump':
        this.audio.jump();
        this.viewmodel.jump();
        break;
      case 'slide':
        this.audio.slide(e.speed);
        this.landDip.kick(-0.35 * 14 * FEEL.landDipPerSpeed); // a small drop into it
        break;
      case 'traverse':
        this.audio.traverse(e.kind);
        this.landDip.kick(-(e.kind === 'vault' ? 0.6 : 0.9) * 14 * FEEL.landDipPerSpeed);
        break;
      case 'land':
        this.audio.land(e.impactSpeed);
        this.viewmodel.land(e.impactSpeed);
        this.landDip.kick(-Math.min(FEEL.landDipMax, e.impactSpeed * FEEL.landDipPerSpeed) * 14);
        break;
      case 'footstep':
        this.audio.footstep(e.sprint, e.crouch, this.footstepSurface());
        break;
      case 'jetIgnite':
        this.hud.dismissBanner('JETPACK — '); // the "how to light it" hint: done
        this.jet.event(e, this.player.move.pos, this.audio.jetpack);
        break;
      case 'jetCutoff':
        this.jet.event(e, this.player.move.pos, this.audio.jetpack);
        break;
      case 'jetLand':
        this.jet.event(e, this.player.move.pos, this.audio.jetpack);
        this.viewmodel.land(e.impactSpeed);
        this.landDip.kick(-Math.min(FEEL.landDipMax, e.impactSpeed * FEEL.landDipPerSpeed) * 14);
        break;
      case 'droneLaunched':
        this.savedView = { yaw: this.input.yaw, pitch: this.input.pitch };
        this.dronePrev = null;
        this.audio.droneStart();
        this.hud.banner(`RECON DRONE UP — anyone it sees shows on your radar`, 2);
        break;
      case 'droneRecalled':
        this.landDrone();
        break;
      case 'droneBattery':
        this.landDrone();
        this.hud.banner('DRONE BATTERY FLAT', 1.5);
        break;
      case 'switchStart':
        this.audio.weaponSwitch(e.to);
        break;
      case 'meleeStart':
        this.audio.knifeSwing(e.move);
        if (this.player.arsenal.melee.windupTotal >= KNIFE.openingWindup - 1e-6) {
          this.partner?.onOpponentChamber(this.player.move.pos);
        }
        break;
      case 'melee':
        this.knifeHit(e.yaw, e.pitch, e.move);
        // Camera follows the cut: roll with the slash direction, a jab for the thrust.
        this.roll.kick((e.move === 'slash' ? 1 : e.move === 'backhand' ? -1 : 0) * 0.9);
        this.landDip.kick(e.move === 'thrust' ? -0.35 : -0.15);
        break;
      case 'grenadeWindup':
        this.audio.grenadePin();
        break;
      case 'grenadeThrow': {
        this.audio.grenadeThrow();
        if (this.online) break;
        const g = spawnGrenade(
          this.nextGrenadeId++,
          this.player.seed,
          eyePosition(this.player),
          e.yaw,
          e.pitch,
          this.player.move.vel,
          this.physics,
          e.kind,
        );
        this.grenades.push(g);
        this.effects.addGrenade(g.id);
        break;
      }
      case 'switchEnd':
        break;
      case 'jammer': {
        const at = this.player.move.pos;
        const { jammed } = this.online
          ? { jammed: [] as string[] }
          : jammerPulse(
              at,
              this.player.seed,
              this.player.drone ? [this.player.drone] : [],
              this.partner
                ? [
                    {
                      id: 'partner',
                      pos: this.partner.state.move.pos,
                      owner: this.partner.state.seed,
                    },
                  ]
                : [],
            );
        if (!this.online && jammed.includes('partner')) this.partner?.jam();
        this.jammerFx.pulse(at);
        this.audio.jammer();
        this.hud.banner(
          this.online
            ? 'JAMMER PULSE'
            : jammed.length
              ? `JAMMER PULSE — ${jammed.length} jammed: no radar on you for ${JAMMER.radarJam} s`
              : 'JAMMER PULSE — nothing in range',
          1.8,
        );
        break;
      }
    }
  }

  private footstepSurface(): SurfaceKind {
    const feet = this.player.move.pos;
    return (
      this.physics.castGroundRay(
        { x: feet.x, y: feet.y + 0.18, z: feet.z },
        { x: 0, y: -1, z: 0 },
        0.8,
      )?.surface ?? 'stone'
    );
  }

  private knifeHit(yaw: number, pitch: number, move: KnifeMove): void {
    const eye = eyePosition(this.player);
    const r = resolveMelee(eye, yaw, pitch, this.physics, this.targets(), move);
    if (r.kind === 'world' && r.visible) {
      this.effects.impact(r.point, r.normal);
      this.audio.knifeHit(false);
    }
    if (r.kind !== 'target') return;
    // Another online player: the server resolves the strike (guard, parry) and confirms it.
    if (r.targetId.startsWith(REMOTE)) return;
    if (r.targetId === 'sparring' && this.partner) {
      const res = applyKnifeStrike(this.player, this.partner.state, move);
      if (res.outcome === 'parried') {
        this.audio.parry();
        this.hud.banner('Parried — you are stunned', 1.2);
        return;
      }
      if (res.outcome !== 'hit') this.audio.guardBlock(res.outcome === 'guardBroken');
      else this.audio.knifeHit(true);
      const killed = this.damagePartner(res.damage);
      this.stats.hits++;
      if (killed) this.stats.kills++;
      this.hud.hitmarker(r.zone, killed);
      if (this.settings.damageNumbers) this.hud.damageNumber(r.point, res.damage, r.zone);
      return;
    }
    const dummy = this.dummies.find((d) => d.def.id === r.targetId);
    if (!dummy) return;
    const dmg = strikeDamage(this.player, move);
    const killed = damageDummy(dummy, dmg);
    this.stats.hits++;
    if (killed) this.stats.kills++;
    this.audio.knifeHit(true);
    this.hud.hitmarker(r.zone, killed);
    this.dummyView.flash(dummy.def.id);
    if (this.settings.damageNumbers) this.hud.damageNumber(r.point, dmg, r.zone);
  }

  private fireShot(shot: ShotFired, inputSeq?: number): void {
    this.stats.shots++;
    const seat = this.player.seat;
    // Trucks as drawn at this step's view time (the server rewinds them there): a passenger
    // shoots from its seat in the truck as drawn, and armour stops rounds like walls.
    const drawn =
      this.online && this.frameViewTime !== undefined
        ? this.online.vehiclesAt(this.frameViewTime)
        : this.drawnVehicles;
    const eye = (seat && seatEyeOf(drawn, seat)) || eyePosition(this.player);
    const slot = this.player.arsenal.slot;
    if (!isGun(slot)) return;
    const cfg = gunConfig(this.player.arsenal, slot);
    const crew = seat?.vehicle;
    const playerTargets = this.targets().filter((t) => !sameCrew(crew, this.crewOf(t.id)));
    const targets = [...playerTargets, ...this.remoteDroneTargets()];
    // Online, smoke as it was at this step's view time (the server judges it there too).
    const concealment = { smoke: this.visibleSmoke, foliage: this.foliage };
    const world = withHulls(this.physics, hullsOf(drawn));
    const ride = seat ? drawn.find((v) => v.id === seat.vehicle) : undefined;
    // Out of the window arc the round meets the cab (the server agrees): no marker.
    const blockedByCab =
      seat !== null && ride !== undefined && !inFireArc(seat.seat, shot.yaw, ride.motion.yaw);
    // Every pellet (1 for most guns) from the shot's seed — the server traces the same fan.
    // Smart rounds bend toward a visible target near the aim (same code on the server).
    const results = blockedByCab
      ? []
      : traceGunShot(eye, shot, cfg, world, targets, concealment, playerTargets);
    const ads = heldGun(this.player)?.adsAmount ?? 0;

    const primary = slot === 'rifle' ? this.player.arsenal.primary : null;
    if (primary === 'coil') this.audio.coilShot();
    else if (primary === 'iskra') this.audio.iskraShot();
    else if (primary === 'shotgun') this.audio.shotgunShot();
    else if (primary === 'marksman') this.audio.marksmanShot();
    else if (primary === 'arc') this.audio.arcShot();
    else this.audio.gunshot(slot);
    this.viewmodel.fire(slot, ads, !cfg.silent);
    this.roll.kick((Math.random() < 0.5 ? -1 : 1) * FEEL.shotRollKick * DEG * 30 * (1 - 0.6 * ads));

    this.muzzle.set(lerp(0.12, 0, ads), lerp(-0.1, -0.06, ads), -0.6);
    this.camera.localToWorld(this.muzzle);
    const zoneRank = { head: 2, torso: 1, legs: 0 } as const;
    const local = new Map<string, { dmg: number; zone: HitZone; point: Vec3 }>();
    let remoteZone: HitZone | null = null;
    // Online players drawn spawn-protected (their shimmer): the server will block the hit.
    const shielded = this.online
      ? new Set(
          this.online
            .remotePlayers(this.frameLocalMs)
            .filter((r) => snapshotProtected(r.pose))
            .map((r) => `${REMOTE}${r.id}`),
        )
      : null;
    let remoteBlocked = false;
    let detailedImpacts = 0;
    for (const result of results) {
      const end = result.kind === 'miss' ? result.end : result.point;
      this.effects.tracer(this.muzzle, end, cfg.tracer === 'arc');
      if (result.kind === 'world' && result.visible) {
        // Shotgun pellets retain every contact decal, but share a three-burst detail budget.
        this.effects.impact(result.point, result.normal, result.surface, detailedImpacts++ < 3);
        this.audio.bulletImpact(result.distance, result.surface);
      }
      if (result.kind !== 'target') continue;
      if (result.targetId.startsWith(REMOTE_DRONE)) continue;
      if (result.targetId.startsWith(REMOTE)) {
        if (shielded?.has(result.targetId)) {
          remoteBlocked = true;
          continue;
        }
        if (remoteZone === null || zoneRank[result.zone] > zoneRank[remoteZone])
          remoteZone = result.zone;
        continue;
      }
      const dmg = computeDamage(result.zone, result.distance, cfg);
      const h = local.get(result.targetId);
      if (!h) local.set(result.targetId, { dmg, zone: result.zone, point: result.point });
      else {
        h.dmg += dmg;
        if (zoneRank[result.zone] > zoneRank[h.zone]) h.zone = result.zone;
      }
    }
    if (remoteZone !== null) {
      // Online: a predicted marker now (the server rewinds to what we saw, so it almost always
      // agrees); damage, the kill marker and the number come with its confirm.
      this.hud.hitmarker(remoteZone, false);
      this.audio.hitmarker(remoteZone, false);
    } else if (remoteBlocked) {
      // Only protected players in the fan: the blocked marker, no damage to come.
      this.hud.blockedMarker();
      this.audio.guardBlock(false);
    }
    // Which marker this shot predicted: its confirm dedupes only the same kind.
    if (this.online && inputSeq !== undefined) {
      this.recordOnlineShotMarker(
        inputSeq,
        remoteZone !== null ? 'hit' : remoteBlocked ? 'blocked' : null,
      );
    }
    for (const [id, h] of local) {
      if (id === 'sparring') {
        const killed = this.damagePartner(h.dmg);
        this.stats.hits++;
        if (killed) this.stats.kills++;
        this.hud.hitmarker(h.zone, killed);
        this.audio.hitmarker(h.zone, killed);
        if (this.settings.damageNumbers) this.hud.damageNumber(h.point, h.dmg, h.zone);
        continue;
      }
      const dummy = this.dummies.find((d) => d.def.id === id);
      if (!dummy) continue;
      const killed = damageDummy(dummy, h.dmg);
      this.stats.hits++;
      if (killed) this.stats.kills++;
      this.hud.hitmarker(h.zone, killed);
      this.audio.hitmarker(h.zone, killed);
      this.dummyView.flash(dummy.def.id);
      if (this.settings.damageNumbers) this.hud.damageNumber(h.point, h.dmg, h.zone);
    }
  }

  private render(dt: number): void {
    const a = this.paused ? 1 : this.accumulator / SIM_DT;
    const cur = this.player.move;
    const old = this.prev.move;
    const w = heldGun(this.player);
    const ow = heldGun(this.prev) ?? w;
    const ads = w && ow ? lerp(ow.adsAmount, w.adsAmount, a) : 0;
    const speed = horizontalSpeed(cur);

    // Low run: half the sprint FOV kick (slower, and it should read as more controlled); a
    // tactical sprint burst pushes it further (speed reads as speed).
    this.sprintFov.update(
      cur.sprinting ? (cur.lowRun ? 0.5 : cur.tacSprint ? FEEL.tacSprintFovScale : 1) : 0,
      dt,
    );
    const dip = this.landDip.update(0, dt);
    // Slide: lean the view a few degrees (less when aimed, so the sights stay level).
    const slide = this.slideFx.update(cur.sliding ? 1 : 0, dt);
    const rollAngle =
      this.roll.update(0, dt) +
      slide * FEEL.slideRollDeg * DEG * (1 - 0.7 * ads) +
      this.jet.roll * (1 - 0.7 * ads);
    let bob = 0;
    const seat = this.player.health > 0 ? this.player.seat : null;
    if (this.settings.cameraBob && cur.grounded && speed > 0.5 && !cur.board && !seat) {
      this.bobPhase += dt * speed * (Math.PI / MOVEMENT.strideLength);
      bob =
        -Math.abs(Math.sin(this.bobPhase)) *
        FEEL.bobAmplitude *
        Math.min(1.4, speed / MOVEMENT.walkSpeed) *
        (1 - 0.8 * ads);
    }

    // Step smoothing: a sudden rise while walking on the ground (a step, a kerb) is absorbed
    // into an offset that decays in ~70 ms, so the view glides up instead of snapping.
    const feetY = lerp(old.pos.y, cur.pos.y, a);
    if (this.lastFeetY !== null && cur.grounded && this.player.move.traversal === null) {
      const rise = feetY - this.lastFeetY;
      if (rise > 0.02 && rise < 0.6) this.stepOffset = Math.max(-0.45, this.stepOffset - rise);
    }
    this.lastFeetY = feetY;
    this.stepOffset *= Math.exp(-dt / 0.07);
    this.correction.update(dt);
    const fix = this.correction.offset;
    this.camera.position.set(
      lerp(old.pos.x, cur.pos.x, a) + fix.x,
      feetY + lerp(old.eyeHeight, cur.eyeHeight, a) + dip + bob + this.stepOffset + fix.y,
      lerp(old.pos.z, cur.pos.z, a) + fix.z,
    );
    this.renderBoard(cur, old, a, speed);
    // In a truck: the driver's chase camera, or the passenger's eye at its seat as drawn.
    this.drawnVehicles = this.online?.vehicles(this.frameLocalMs) ?? [];
    const driving = seat?.seat === 'driver';
    if (seat) this.seatCamera(seat, a, dt);
    if (!driving) treeFade.r.value = 0;
    const recoilPitch = w && ow ? lerp(ow.recoilPitch, w.recoilPitch, a) * DEG : 0;
    const recoilYaw = w && ow ? lerp(ow.recoilYaw, w.recoilYaw, a) * DEG : 0;
    const shake = this.shake.update(0, dt) * 0.004;
    const jetShake = this.jet.shake(this.lastTime);
    this.camera.rotation.set(
      this.input.pitch + recoilPitch + shake * Math.sin(this.lastTime * 61) + jetShake.pitch,
      this.input.yaw - recoilYaw + shake * Math.sin(this.lastTime * 47) + jetShake.yaw,
      rollAngle,
      'YXZ',
    );
    // Flying the drone: the camera is the drone's (interpolated between sim steps).
    const drone = this.player.drone;
    const flying = drone?.alive === true;
    if (flying) {
      const p = this.dronePrev ?? drone.pos;
      this.camera.position.set(
        lerp(p.x, drone.pos.x, a),
        lerp(p.y, drone.pos.y, a),
        lerp(p.z, drone.pos.z, a),
      );
      this.camera.rotation.set(this.input.pitch, this.input.yaw, 0, 'YXZ');
    }
    // The parry punch-in narrows the view for a moment (presentation only).
    const vfov = this.currentVfov(ads) * this.viewmodel.fovScale;
    // A camera moment (intro, death/kill cam, victory) takes the camera out of the head.
    const outside = !flying && this.updateCinematic(dt, vfov);
    this.camera.getWorldDirection(this.blastAudioForward);
    this.blastAudioQueue.flush(
      this.camera.position,
      this.blastAudioForward,
      this.physics,
      (distance, context) => this.audio.explosion(distance, context),
    );
    this.remoteShotAudioQueue.flush(
      this.camera.position,
      this.blastAudioForward,
      this.physics,
      (kind, distance, context) => {
        if (kind === 'coil') this.audio.remoteCoilShot(distance, context);
        else this.audio.remoteGunshot(kind, distance, context);
      },
    );
    // Marksman scopes (coilgun, SR-8): fully aimed shows the reticle overlay instead of the gun.
    const scoped =
      !flying &&
      !outside &&
      this.player.arsenal.slot === 'rifle' &&
      gunConfig(this.player.arsenal, 'rifle').scope &&
      (heldGun(this.player)?.adsAmount ?? 0) > 0.85;
    this.hud.setScope(scoped);
    this.viewmodel.scene.visible = !flying && !scoped && !outside && !driving;
    this.hud.root.classList.toggle('driving', driving && !outside);
    if (!outside && Math.abs(this.camera.fov - vfov) > 1e-4) {
      this.camera.fov = vfov;
      this.camera.updateProjectionMatrix();
    }

    // Shadow frustum follows the viewpoint — the player, or the drone while flying — snapped to
    // texels to avoid shimmering; the sun sits along the weather's sun direction.
    {
      const cam = this.sun.shadow.camera;
      const texel = (cam.right - cam.left) / this.sun.shadow.mapSize.x;
      const view = flying || outside ? this.camera.position : cur.pos;
      const cx = Math.round(view.x / texel) * texel;
      const cz = Math.round(view.z / texel) * texel;
      const d = this.weather.sunDir;
      this.sun.target.position.set(cx, 0, cz);
      this.sun.position.set(cx + d.x * 250, d.y * 250, cz + d.z * 250);
    }
    this.facade?.update(this.camera.position, this.camera);
    updateMarketDistrictDetail(this.marketDistrictDetail, this.camera.position, this.quality);
    this.renderProps();
    this.props?.update(this.camera.position);
    updateFoliage(this.scene, this.camera.position);
    updateSetDressing(this.dressing, this.camera.position, this.camera);
    if (this.heroes) updateHeroes(this.heroes, this.camera.position);
    if (this.trees) updateTrees(this.trees, this.camera.position);
    this.weather.update(dt);
    this.effects.setImpactLighting(this.sun, this.hemi);
    this.vehiclesView?.tyres.setLighting(this.sun, this.hemi);
    this.neonDistrict.update(dt);
    // One gust signal drives the wind sound, the foliage sway and the blowing dust.
    const gust = this.gusts.update(dt);
    this.audio.windTick(gust);
    setFoliageGust(gust);
    const wx = WEATHER_PRESETS[this.settings.weather];
    this.windMotes.update(
      dt,
      this.camera.position,
      windStrengthFor(wx) * (0.5 + 0.5 * gust),
      wx.rain,
      this.lastTime,
    );
    this.vehiclesView?.tyres.setWind(
      foliageWind.dir.value.x,
      foliageWind.dir.value.y,
      windStrengthFor(wx) * (0.5 + 0.5 * gust),
    );
    this.updateBreathing(dt);
    this.sky.update(dt, this.camera);
    this.rain.update(dt, this.camera, windStrengthFor(wx), gust, foliageWind.dir.value);
    this.updateRainCover(dt, wx.rain);
    this.govern(dt);

    const look = this.input.consumeLookDelta();
    const reloadProgress = w && w.reloadTimer > 0 ? 1 - w.reloadTimer / w.reloadDuration : -1;
    const ars = this.player.arsenal;
    const mel = ars.melee;
    const meleeRecover = KNIFE.recovery + (mel.quick ? KNIFE.quickMeleeExtra : 0);
    const throwTotal = GRENADE.windup + GRENADE.recovery;
    this.viewmodel.setPrimary(this.player.arsenal.primary);
    if (this.input.consumePress('inspect')) this.viewmodel.inspect();
    const heldCfg = isGun(ars.slot) ? gunConfig(ars, ars.slot) : null;
    this.viewmodel.update(dt, {
      slot: ars.target,
      switchProgress: ars.switchTimer > 0 ? 1 - ars.switchTimer / ars.switchDuration : 1,
      melee:
        mel.phase === 'idle'
          ? null
          : {
              quick: mel.quick,
              move: mel.move,
              windup: mel.windupTotal,
              total: mel.windupTotal + meleeRecover,
              elapsed:
                mel.phase === 'windup'
                  ? mel.windupTotal - mel.timer
                  : mel.windupTotal + meleeRecover - mel.timer,
            },
      throw:
        ars.throwPhase === 'idle'
          ? null
          : {
              windup: GRENADE.windup,
              total: throwTotal,
              elapsed:
                ars.throwPhase === 'windup'
                  ? GRENADE.windup - ars.throwTimer
                  : throwTotal - ars.throwTimer,
            },
      adsAmount: ads,
      guard: this.player.arsenal.guard.held,
      stunned: this.player.arsenal.stun > 0,
      // Mid-climb the hands are busy: weapon drops into the sprint pose.
      sprinting: cur.sprinting || this.player.move.traversal !== null,
      prone: cur.prone,
      sliding: cur.sliding,
      reload: reloadProgress,
      reloadEmpty: heldCfg !== null && w !== null && w.reloadDuration === heldCfg.reloadEmptyTime,
      magEmpty: w !== null && w.ammo === 0 && !heldCfg?.heat,
      vent: w && heldCfg?.heat && w.overheat > 0 ? 1 - w.overheat / heldCfg.heat.lockout : -1,
      ventLockout: heldCfg?.heat?.lockout ?? 1.6,
      speed,
      grounded: cur.grounded,
      lookDx: look.dx,
      lookDy: look.dy,
      bob: this.settings.cameraBob,
    });
    this.dummyView.update(this.dummies, dt, this.player.move.pos);
    const onlineTactical = this.online?.tactical ?? null;
    if (onlineTactical) {
      this.pickups.splice(
        0,
        this.pickups.length,
        ...onlineTactical.pickups.map((p) => ({
          id: p.id,
          pos: { ...p.pos },
          kind: p.kind,
          cooldown: p.cooldown,
        })),
      );
      this.tactical.radar = { ...onlineTactical.radar };
      this.tactical.jammed = onlineTactical.jammed;
      const spottedIds = new Set(onlineTactical.spotted.map((s) => s.id));
      if (onlineTactical.spotted.some((s) => !this.onlineSpottedIds.has(s.id)))
        this.audio.spotPing();
      this.onlineSpottedIds.clear();
      for (const id of spottedIds) this.onlineSpottedIds.add(id);
      this.tactical.spotted = onlineTactical.spotted.map((s) => ({ id: s.id, t: s.t }));
      this.tactical.drone = this.player.drone;
      this.tactical.droneCharges = this.player.droneCharges;
      this.board = onlineTactical.board
        ? { pos: { ...onlineTactical.board.pos }, rider: onlineTactical.board.rider }
        : null;
      this.jetpacks = onlineTactical.jetpacks ?? [];
      this.radar.setVisible(this.pickups.length > 0);
    }
    this.pickupView.update(dt, this.pickups);
    this.weaponDropView.update(dt, this.drops());
    // Drawn at the same view time smart rounds judge it (`visibleSmoke`): what you see is what hides.
    this.smokeView.update(dt, this.visibleSmoke, this.lastTime);
    this.jammerFx.update(dt);
    // Radar: nobody unless called in (everyone), spotted by your drone (just them), or jammed.
    const view = radarView(this.tactical);
    const spottedFromServer = this.online
      ? (onlineTactical?.spotted.map((s) => ({ id: s.id, pos: s.pos })) ?? [])
      : null;
    const everyone = [
      ...this.dummies.filter((d) => d.health > 0).map((d) => ({ id: d.def.id, pos: d.pos })),
      ...(this.partner?.alive ? [{ id: 'partner', pos: this.partner.state.move.pos }] : []),
      ...(this.online
        ?.remotePlayers(this.frameLocalMs)
        .filter((p) => p.pose.hp > 0)
        .map((p) => ({
          id: p.id,
          pos: { x: p.pose.x, y: p.pose.y, z: p.pose.z },
        })) ?? []),
    ];
    const spottedIds = new Set(this.tactical.spotted.map((s) => s.id));
    const shown =
      view === 'live'
        ? everyone
        : view === 'spotted'
          ? (spottedFromServer ?? everyone.filter((o) => spottedIds.has(o.id)))
          : [];
    this.radar.update(dt, {
      // Body-centred and body-facing (while flying, the mouse turns the drone, not you).
      self: { x: cur.pos.x, z: cur.pos.z, yaw: flying ? this.player.view.yaw : this.input.yaw },
      others: shown.map((o) => o.pos),
      view,
      // Uplinks only: medkits aren't advertised on the radar (you learn where they are).
      uplinks: this.pickups.flatMap((p) =>
        p.kind === 'medkit' ? [] : [{ x: p.pos.x, z: p.pos.z, cooldown: p.cooldown, kind: p.kind }],
      ),
      live: this.tactical.radar.live,
      charges: this.tactical.radar.charges,
      callKey: this.keyFor('radar'),
      bounds: this.map.bounds,
    });
    const partner = this.partner;
    if (partner) {
      this.partnerView.update(dt, partner.state, partner.prev, a, this.lastTime);
      // Tell: an opponent chambering a strike at you, within reach.
      const pm = partner.state.arsenal.melee;
      const pp = partner.state.move.pos;
      const dist = Math.hypot(pp.x - cur.pos.x, pp.z - cur.pos.z);
      if (partner.alive && pm.phase === 'windup' && isOpeningWindup(pm.windupTotal) && dist < 5) {
        const progress = Math.min(1, 1 - pm.timer / pm.windupTotal);
        // A slash from the attacker's right arrives on your left; backhand on your right.
        const side = pm.move === 'thrust' ? 'center' : pm.move === 'slash' ? 'left' : 'right';
        const toP = Math.atan2(-(pp.x - cur.pos.x), -(pp.z - cur.pos.z)); // yaw that faces them
        let bearing = this.input.yaw - toP; // + = they are to your right
        bearing = Math.atan2(Math.sin(bearing), Math.cos(bearing));
        this.hud.knifeTell(true, side, progress, bearing);
      } else {
        this.hud.knifeTell(false);
      }
    } else {
      this.hud.knifeTell(false);
    }
    if (this.online && this.remoteView) this.renderRemotes(dt);
    this.renderDrones(dt);
    this.renderVehicles(dt, a);
    this.hud.setDropPrompt(
      weaponDropPrompt(
        this.drops(),
        this.player,
        this.truckPromptVisible ||
          (this.online?.dropTruckPriority(this.player, this.physics) ?? false),
        this.keyFor('interact'),
      ),
    );
    this.actorContacts.begin(this.camera, this.quality !== 'low');
    for (const dummy of this.dummies) if (dummy.health > 0) this.actorContacts.add(dummy.pos);
    if (this.partner?.alive)
      this.actorContacts.add(this.partner.state.move.pos, this.partner.state.move.grounded);
    if (this.online) {
      for (const remote of this.drawnRemotes) {
        const pose = remote.pose;
        if (pose.hp <= 0 || pose.vh !== undefined || (pose.f & SnapFlag.Board) !== 0) continue;
        this.contactActorPosition.set(pose.x, pose.y, pose.z);
        this.actorContacts.add(this.contactActorPosition, (pose.f & SnapFlag.Grounded) !== 0);
      }
    }
    this.actorContacts.end();
    this.updateLocalSoldier(dt, cur, old, a);
    this.renderJetpacks(dt, cur, old, a, outside);
    const guard = this.player.arsenal.guard;
    this.hud.setGuard(guard.held, 3 - guard.blocks, guard.brokenTimer > 0);
    this.effects.setImpactView(
      this.camera,
      window.innerHeight,
      this.quality === 'low',
      this.visibleSmoke,
    );
    this.effects.update(dt, this.grenades, a);

    const slot = ars.slot;
    const spread =
      w && isGun(slot)
        ? currentSpread(
            w,
            // The context the sim's own shot uses (seated: no truck speed in the spread).
            weaponContext(this.player),
            gunConfig(ars, slot),
          )
        : 0;
    this.hud.updateCrosshair(spread, vfov, ads, cur.sprinting, {
      knife: !isGun(ars.target),
      redDot: this.viewmodel.redDot(slot),
    });
    this.hud.setLoadout(ars.target, ars.mode, ars.grenades);
    this.hud.setEquipment(ars.smokes, ars.jammers, this.player.droneCharges, {
      smoke: this.keyFor('smoke'),
      jammer: this.keyFor('jammer'),
      drone: this.keyFor('drone'),
    });
    this.hud.setDrone(
      flying
        ? {
            battery: drone.battery,
            max: DRONE.battery,
            recallKey: this.keyFor('drone'),
            upKey: this.keyFor('jump'),
            downKey: this.keyFor('crouch'),
          }
        : null,
    );
    // Brackets on spotted players while flying (projected to the screen).
    const marks: { x: number; y: number }[] = [];
    if (flying) {
      // The camera moved to the drone this frame: refresh its matrices before projecting.
      this.camera.updateMatrixWorld();
      const w2 = window.innerWidth / 2;
      const h2 = window.innerHeight / 2;
      for (const p of spottedBracketWorldPoints(everyone, spottedIds, spottedFromServer)) {
        const v = new THREE.Vector3(p.x, p.y, p.z).project(this.camera);
        if (v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1)
          marks.push({ x: w2 + v.x * w2, y: h2 - v.y * h2 });
      }
    }
    this.hud.setSpotMarks(marks);
    if (w && isGun(slot)) {
      const gun = gunConfig(this.player.arsenal, slot);
      if (gun.heat) this.hud.setHeat(w.heat, w.overheat > 0, gun.name);
      else this.hud.setAmmo(w.ammo, w.reserve, gun.name, w.reloadTimer > 0, gun.magazineSize);
    } else this.hud.setAmmo(-1, -1, KNIFE.name, false);
    this.hud.setHealth(this.player.health, 100);
    this.hud.setStatus({
      prone: this.player.move.prone,
      board: this.player.move.board,
      protection: protectionShare(this.player),
      tac: { on: this.player.move.tacSprint, fuel: this.player.move.tacFuel },
    });
    this.hud.setReload(reloadProgress);
    this.hud.update(dt, this.camera);
    const board = this.scoreboardForced || (this.input.held('scoreboard') && !this.paused);
    this.scoreboard.update(board ? this.scoreboardView() : null);
    this.chat?.frame({
      chatPressed: this.input.consumePress('chat'),
      quickHeld: this.input.held('quickChat') && !this.paused,
      scoreboardOpen: board,
      locked: this.input.locked || this.opts.autotest === true,
    });

    this.renderer.info.reset();
    this.shadowGeometry.reset();
    // The viewmodel samples the baked lamp volume where the (world) camera is.
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    updateLampProbe(this.camera);
    this.gpuTimer.poll(dt * 1000);
    this.gpuTimer.begin();
    this.post.render(dt);
    this.gpuTimer.end();

    this.perf.frame(
      dt,
      this.renderer.info,
      this.stepsThisFrame,
      `${this.quality} @ ${Math.round(this.resolutionScale * 100)}%${this.paused ? ' (menu capped at 30)' : ''}`,
      {
        pos: cur.pos,
        speed,
        grounded: cur.grounded,
        crouched: cur.crouched,
        sprinting: cur.sprinting,
      },
      this.shadowGeometry,
    );
  }

  /** The moments' switch: the setting, and `&cine` (or a hook) on autotest pages. */
  private get cineEnabled(): boolean {
    return this.settings.cinematicCameras && this.cineAllowed;
  }

  /**
   * The match intro, once per page after the first Play (online: once the server has placed
   * us). True if it started — then a friend room's `ready` waits for it (see `introHolding`).
   */
  private maybeStartIntro(): boolean {
    if (!this.introPending || !this.playedOnce || this.opts.autotest) return false;
    if (!this.cineEnabled || this.settings.skipIntro) {
      this.introPending = false;
      return false;
    }
    if (this.online && !this.online.welcome) return false; // starts at the welcome
    this.introPending = false;
    return this.startIntro();
  }

  /** The fly-over is authored for the Market only (Kiran: the other maps skip it). */
  private get introKeys(): readonly IntroKey[] | null {
    const c = this.mapChoice;
    return c.map === 'defilad' && c.size === 'market' ? MARKET_INTRO : null;
  }

  private startIntro(): boolean {
    this.director.setEnabled(this.cineEnabled);
    const keys = this.introKeys;
    if (!keys || this.player.drone || this.player.health <= 0) return false;
    if (!this.director.startIntro()) return false;
    this.cinematic.planIntro(
      keys,
      eyePosition(this.player),
      this.input.yaw,
      this.input.pitch,
      this.shot.cast,
    );
    // Spawn protection holds while the camera flies (nothing is simulated or sent meanwhile).
    if (this.sendReady) this.introHolding = true;
    return true;
  }

  /** Server ms the kill cam replays at this frame (NaN: no replay — offline or unknown time). */
  private replayMs(): number {
    const k = this.director.kill;
    if (!k || !Number.isFinite(k.killMs)) return Number.NaN;
    const start = k.killMs + (CINE.killcamPostRoll - CINE.killcamLength) * 1000;
    return start + this.director.replayTime * 1000;
  }

  private subjectFrom(out: ShotSubject, p: RemotePose): ShotSubject {
    out.pos.x = p.x;
    out.pos.y = p.y;
    out.pos.z = p.z;
    out.yaw = p.yaw;
    out.pitch = p.pitch;
    out.eye = p.eye;
    return out;
  }

  /** The kill cam's killer: replayed from the rings online, the live partner offline. */
  private killerOf(): ShotSubject | null {
    const id = this.director.kill?.killer;
    if (!id) return null;
    if (id === 'partner') {
      const p = this.partner;
      if (!p) return null;
      const out = this.killerSubject;
      const m = p.state.move;
      out.pos.x = m.pos.x;
      out.pos.y = m.pos.y;
      out.pos.z = m.pos.z;
      out.yaw = p.state.view.yaw;
      out.pitch = p.state.view.pitch;
      out.eye = m.eyeHeight;
      return out;
    }
    const ring = this.replay.ringOf(id);
    const t = this.replayMs();
    if (ring && Number.isFinite(t) && ring.sample(t, this.scratchPose)) {
      return this.subjectFrom(this.killerSubject, this.scratchPose);
    }
    const live = this.liveRemote(id);
    return live ? this.subjectFrom(this.killerSubject, live.pose) : null;
  }

  /** The victory shot's subject: us if we (also) won, else the first winner; null = wide shot. */
  private winnerOf(): ShotSubject | null {
    const session = this.online;
    const me = session?.id ?? 'local';
    // The results' winners (a preview outside the results frames us).
    const m = session?.match;
    const winners = m?.phase === 'ended' ? m.winners : null;
    const first = !winners || winners.includes(me) ? me : winners[0];
    if (!first) return null;
    if (first === me) {
      const out = this.winnerSubject;
      const m = this.player.move;
      out.pos.x = m.pos.x;
      out.pos.y = m.pos.y;
      out.pos.z = m.pos.z;
      out.yaw = this.player.health > 0 ? this.input.yaw : this.player.view.yaw;
      out.pitch = 0;
      out.eye = m.eyeHeight;
      return out;
    }
    const live = this.liveRemote(first);
    return live ? this.subjectFrom(this.winnerSubject, live.pose) : null;
  }

  /** Another player as drawn last frame (no extra interpolation sampling or garbage). */
  private liveRemote(id: string): RemotePlayer | null {
    for (const r of this.lastLive) if (r.id === id) return r;
    return null;
  }

  /**
   * Input for the camera moments, before the sim steps (so a respawn lands before this frame's
   * camera): any press hands the intro / victory shot back, and offline respawns early from a
   * death moment. The setting switched off mid-death respawns offline at once.
   */
  private pollCinematicInput(): void {
    const d = this.director;
    if (d.enabled !== this.cineEnabled) d.setEnabled(this.cineEnabled);
    // Read every frame, so activity from before a moment never skips it.
    const activity = this.input.consumeActivity();
    const offlineWait = !this.online && this.respawnTimer > 0;
    if (offlineWait && !d.deathShot) {
      this.respawn();
      return;
    }
    if (this.online && d.deathShot && !d.preview) {
      // A death moment only while dead in the life it belongs to (see `deathLife`).
      this.aliveInDeath = this.player.health > 0 ? this.aliveInDeath + (this.lastFrameDt || 0) : 0;
      if (this.online.currentLife !== this.deathLife || this.aliveInDeath > 1) d.respawned();
    }
    if (activity === 0 || !d.outside || d.skip()) return;
    // Only a press respawns (not a look); the one that killed you (still held, a click) doesn't
    // count: only after the pull-out.
    if (offlineWait && activity === 2 && (d.mode !== 'death' || d.time > 0.3)) this.respawn();
  }

  /**
   * Run the camera moments for this frame: the director's clock, the intro's hold on `ready`,
   * then the shot itself (written into the camera) and the HUD's cinematic state. Returns
   * whether the camera is outside the head.
   */
  private updateCinematic(dt: number, vfov: number): boolean {
    const d = this.director;
    d.update(dt);
    // The kill cam's window stays frozen only while a death moment plays.
    if (!d.deathShot) this.replay.unfreeze();
    if (this.introHolding && d.mode !== 'intro') {
      this.introHolding = false;
      this.readyOnce();
    }
    const s = this.shot;
    if (d.outside) {
      s.dt = dt;
      s.fpPos.copy(this.camera.position);
      s.fpQuat.copy(this.camera.quaternion);
      s.fpFov = vfov;
      s.baseFov = verticalFov(this.settings.fov);
      const m = this.player.move;
      s.self.pos.x = m.pos.x;
      s.self.pos.y = m.pos.y;
      s.self.pos.z = m.pos.z;
      s.self.yaw = this.player.health > 0 ? this.input.yaw : this.player.view.yaw;
      s.self.pitch = this.player.health > 0 ? this.input.pitch : this.player.view.pitch;
      s.self.eye = m.eyeHeight;
      s.killer = d.mode === 'killcam' || d.mode === 'death' ? this.killerOf() : null;
      s.winner = d.mode === 'victory' ? this.winnerOf() : null;
    }
    const outside = this.cinematic.update(s, this.camera);
    const offlineDeath = d.deathShot && !this.online && this.respawnTimer > 0;
    const skippable = d.mode === 'intro' || d.mode === 'victory' || d.preview;
    const hint = offlineDeath
      ? 'Press any key to respawn'
      : skippable
        ? 'Press any key to skip'
        : '';
    this.hud.setCinematic(outside ? d.mode : null, hint);
    this.hud.setKillCam(outside && d.mode === 'killcam' ? d.kill : null);
    return outside;
  }

  /**
   * Our own soldier, drawn only while the camera is outside the head (and not inside the body):
   * live from the sim, or — in the kill cam — replayed as the victim, going down at the blow.
   */
  private updateLocalSoldier(dt: number, cur: MoveState, old: MoveState, a: number): void {
    const sol = this.localSoldier;
    if (!sol) return;
    const atWheel = this.player.health > 0 && this.player.seat?.seat === 'driver';
    const show = (this.director.outside && this.cinematic.eyeDistance > 0.9) || atWheel;
    sol.root.visible = show;
    if (!show) {
      // Hidden, but never left lying dead: a soldier last drawn dead (or as the replay's
      // victim) is synced to the living player now, so the next death starts from a standing
      // body, not a clamped death pose.
      if (this.localSoldierStale && this.player.health > 0) {
        this.localSoldierStale = false;
        this.liveLocalPose(cur, cur, 1);
        sol.update(this.localPose, 0);
      }
      return;
    }
    // The soldier stands on its own deck while riding: not a second board under the feet.
    this.boardUnder.visible = false;
    const p = this.localPose;
    const t = this.replayMs();
    const kill = this.director.kill;
    if (
      this.director.mode === 'killcam' &&
      kill &&
      Number.isFinite(t) &&
      this.replay.self.sample(t, this.scratchPose)
    ) {
      const r = this.scratchPose;
      p.x = r.x;
      p.y = r.y;
      p.z = r.z;
      p.yaw = r.yaw;
      p.pitch = r.pitch;
      p.crouched = (r.f & SnapFlag.Crouched) !== 0;
      p.grounded = (r.f & SnapFlag.Grounded) !== 0;
      p.sprinting = (r.f & SnapFlag.Sprinting) !== 0;
      p.riding = (r.f & SnapFlag.Board) !== 0;
      p.prone = (r.f & SnapFlag.Prone) !== 0;
      p.jetpack = (r.f & SnapFlag.Jetpack) !== 0;
      p.flying = (r.f & SnapFlag.JetFlight) !== 0;
      // The victim goes down at the blow, whenever our own health caught up with it.
      p.alive = t < kill.killMs;
      p.weapon = heldWeapon(SNAP_SLOTS[r.sl] ?? 'rifle', r.primary);
      p.action = r.action;
      p.hp = p.alive ? r.hp : 0;
      this.localSoldierStale = true; // a replayed pose: not where (or how) we are now
      sol.update(p, dt);
      return;
    }
    this.liveLocalPose(cur, old, a);
    if (!p.alive) this.localSoldierStale = true;
    sol.update(p, dt);
  }

  /** Our own soldier's pose from the live sim state (into `localPose`). */
  private liveLocalPose(cur: MoveState, old: MoveState, a: number): void {
    const p = this.localPose;
    const pl = this.player;
    const alive = pl.health > 0;
    p.x = lerp(old.pos.x, cur.pos.x, a);
    p.y = lerp(old.pos.y, cur.pos.y, a);
    p.z = lerp(old.pos.z, cur.pos.z, a);
    p.yaw = alive ? this.input.yaw : pl.view.yaw;
    p.pitch = alive ? this.input.pitch : pl.view.pitch;
    p.crouched = cur.crouched || pl.seat !== null;
    p.grounded = cur.grounded;
    p.sprinting = cur.sprinting;
    p.riding = cur.board;
    p.seated = pl.seat !== null;
    p.prone = cur.prone;
    p.jetpack = cur.jet !== 0;
    p.flying = cur.jet >= 2;
    p.alive = alive;
    p.weapon = heldWeapon(pl.arsenal.slot, pl.arsenal.primary);
    p.action = playerAction(pl);
    p.hp = pl.health;
  }

  /**
   * Online: keep our own pose for the kill cam (the victim). The clock reads the server time of
   * what arrives now; our predicted input reaches the server a round trip later, so that is
   * where this pose sits on the server's timeline (the others are drawn on it).
   */
  private recordSelf(session: OnlineSession): void {
    const clock = session.serverNow(this.frameLocalMs);
    if (clock === null) return;
    const now = clock + Math.max(0, session.rtt);
    const pl = this.player;
    const m = pl.move;
    const r = this.selfPose;
    r.x = m.pos.x;
    r.y = m.pos.y;
    r.z = m.pos.z;
    r.yaw = pl.health > 0 ? this.input.yaw : pl.view.yaw;
    r.pitch = pl.health > 0 ? this.input.pitch : pl.view.pitch;
    r.eye = m.eyeHeight;
    r.f =
      (m.grounded ? SnapFlag.Grounded : 0) |
      (m.crouched ? SnapFlag.Crouched : 0) |
      (m.sprinting ? SnapFlag.Sprinting : 0) |
      (m.board ? SnapFlag.Board : 0) |
      (m.prone ? SnapFlag.Prone : 0) |
      (m.jet !== 0 ? SnapFlag.Jetpack : 0) |
      (m.jet >= 2 ? SnapFlag.JetFlight : 0) |
      (m.jet === 3 ? SnapFlag.JetDrop : 0) |
      (m.jetThrust ? SnapFlag.JetThrust : 0);
    r.hp = pl.health;
    // A respawn is a cut in the replay, never a blend (see `PoseRing.sample`).
    r.life = session.currentLife;
    r.sl = Math.max(0, SNAP_SLOTS.indexOf(pl.arsenal.slot));
    r.primary = pl.arsenal.primary;
    const act = playerAction(pl);
    r.action.kind = act.kind;
    r.action.v = act.v;
    r.action.t = act.t;
    this.replay.self.push(now, r);
  }

  /** The kill cam's players: everyone as they were at the replay time (reused objects). */
  private replayedPlayers(session: OnlineSession, t: number): RemotePlayer[] {
    const list = this.replayList;
    list.length = 0;
    const rings = this.replay.remotes;
    for (let slot = 0; slot < rings.length; slot++) {
      const ring = rings[slot]!;
      const out = this.replayPlayers[slot]!;
      // Only players recorded around that time (not one who left before it).
      if (!ring.count || t > ring.newest + 500 || t < ring.oldest - 500) continue;
      if (!ring.sample(t, out.pose)) continue;
      if (out.id !== ring.id) {
        out.id = ring.id;
        out.name = session.nameOf(ring.id, '…');
      }
      out.slot = slot;
      list.push(out);
    }
    return list;
  }

  /** Online: place the other players (interpolated ~100 ms back) and their name tags. */
  private renderRemotes(dt: number): void {
    const session = this.online!;
    const live = session.remotePlayers(this.frameLocalMs);
    this.lastLive = live;
    // Everyone's pose for the kill cam, on the draw timeline (ours on the server's present).
    const vt = this.frameViewTime;
    if (vt !== undefined) for (const p of live) this.replay.recordRemote(p.slot, p.id, vt, p.pose);
    this.recordSelf(session);
    const t = this.replayMs();
    const replaying = this.director.mode === 'killcam' && Number.isFinite(t);
    const players = replaying ? this.replayedPlayers(session, t) : live;
    this.drawnRemotes = players;
    const outside = this.director.outside;
    // Name tags only for players you can actually see (walls, smoke and foliage hide them, the
    // same sight rule bots use), re-checked a few times a second.
    this.tagSightTimer -= dt;
    if (this.tagSightTimer <= 0) {
      this.tagSightTimer = 0.15;
      const eye = eyePosition(this.player);
      // Trucks hide players behind them like walls (no tag floating over a roof).
      const sight = withTrucks(this.physics, this.queryVehicles());
      this.tagSight = new Map(
        players.map((p) => {
          const head = { x: p.pose.x, y: p.pose.y + p.pose.eye, z: p.pose.z };
          const near = Math.hypot(head.x - eye.x, head.z - eye.z) < 60;
          const seen =
            near &&
            sightVisibility(eye, head, sight, this.visibleSmoke, this.foliage) >= SIGHT_THRESHOLD;
          return [p.id, seen];
        }),
      );
    }
    // No name tags in a camera moment (the kill-cam card names the killer).
    this.remoteView!.update(players, (p) => !outside && this.tagSight.get(p.id) === true, dt);
    this.onlineBadge?.update(dt, session, performance.now());
  }

  private readonly droneBuzzPoint = new THREE.Vector3();

  private renderDrones(dt: number): void {
    const drones = this.online?.remoteDrones(this.frameLocalMs) ?? [];
    this.drawnDrones = drones;
    this.droneView.update(dt, drones);
    let buzz = 0;
    for (const d of drones) {
      this.droneBuzzPoint.set(d.pos.x, d.pos.y, d.pos.z);
      const dist = this.camera.position.distanceTo(this.droneBuzzPoint);
      buzz = Math.max(buzz, Math.max(0, 1 - dist / 34) * 0.045);
    }
    this.audio.setRemoteDrones(buzz);
  }

  /**
   * Jetpacks this frame: pickups, everyone's exhaust (ours from the body in first person, from
   * the worn pack when our soldier is drawn), dust, the HUD module, the feel and the sound.
   */
  private renderJetpacks(
    dt: number,
    cur: MoveState,
    old: MoveState,
    a: number,
    outside: boolean,
  ): void {
    const flyers = this.jetFlyers;
    flyers.length = 0;
    const view = this.remoteView;
    if (this.online && view) jetFlyersOf(this.drawnRemotes, (id) => view.soldierOf(id), flyers);
    const feet = {
      x: lerp(old.pos.x, cur.pos.x, a),
      y: lerp(old.pos.y, cur.pos.y, a),
      z: lerp(old.pos.z, cur.pos.z, a),
    };
    this.jet.frame({
      dt: this.paused ? 0 : dt,
      items: this.jetpacks,
      self: cur,
      selfAlive: this.player.health > 0,
      selfFeet: feet,
      yaw: this.input.yaw,
      selfSoldier: this.localSoldier?.root.visible ? this.localSoldier : null,
      firstPerson: !outside,
      others: flyers,
      ear: this.camera.position,
      earYaw: this.input.yaw,
      sound: this.audio.jetpack,
      groundBelow: (p) => groundBelowAt((o, d, max) => this.physics.castGroundRay(o, d, max), p),
      jumpKey: this.keyFor('jump'),
    });
  }

  /**
   * The skateboard: lying at its spot (or where its rider fell), under our feet while we ride
   * (seen when looking down), the rolling sound, and the pickup banner. Other riders' boards are
   * drawn by their soldiers.
   */
  private renderBoard(cur: MoveState, old: MoveState, a: number, speed: number): void {
    const b = this.board;
    this.boardLying.visible = b !== null && b.rider === null;
    if (b && b.rider === null) this.boardLying.position.set(b.pos.x, b.pos.y, b.pos.z);
    const riding = cur.board && this.player.health > 0;
    this.boardUnder.visible = riding;
    if (riding) {
      this.boardUnder.position.set(
        lerp(old.pos.x, cur.pos.x, a),
        lerp(old.pos.y, cur.pos.y, a),
        lerp(old.pos.z, cur.pos.z, a),
      );
      aimBoard(this.boardUnder, cur.vel.x, cur.vel.z, this.input.yaw + Math.PI);
    }
    this.audio.setRoll(riding && cur.grounded ? speed : 0);
    if (riding && !this.wasRiding) {
      this.audio.pickupCharge();
      this.hud.banner('SKATEBOARD — ride it until you drop', 2.5);
    }
    this.wasRiding = riding;
    // Heal cue: health went up within a life (offline or the server's medkit heal).
    const hp = this.player.health;
    if (hp > this.lastHealth && this.lastHealth > 0) {
      this.audio.heal();
      this.hud.heal();
      this.hud.banner(`+${Math.round(hp - this.lastHealth)} HEALTH`, 1.4);
    }
    this.lastHealth = hp;
  }

  /** Snapshot for tests and the perf overlay. */
  snapshot(): Record<string, unknown> {
    const m = this.player.move;
    const w = heldGun(this.player);
    const ars = this.player.arsenal;
    const gpuMedianMs = this.gpuTimer.median();
    return {
      slot: ars.slot,
      target: ars.target,
      mode: ars.mode,
      grenades: ars.grenades,
      liveGrenades: this.grenades.length,
      lastExplosion: this.lastExplosion,
      health: this.player.health,
      guard: this.player.arsenal.guard.held,
      stun: this.player.arsenal.stun,
      counter: this.player.arsenal.counter,
      partner: this.partner
        ? {
            alive: this.partner.alive,
            health: this.partner.state.health,
            pos: { ...this.partner.state.move.pos },
            stun: this.partner.state.arsenal.stun,
            guard: this.partner.state.arsenal.guard.held,
            melee: this.partner.state.arsenal.melee.phase,
          }
        : null,
      map: { name: this.map.name, spawns: this.spawns.length, bounds: this.map.bounds },
      tactical: {
        smokes: this.player.arsenal.smokes,
        jammers: this.player.arsenal.jammers,
        droneCharges: this.player.droneCharges,
        flying: this.player.drone?.alive === true,
        drone: this.player.drone ? { ...this.player.drone.pos } : null,
        remoteDrones: this.drawnDrones.length,
        spotted: this.tactical.spotted.map((s) => s.id),
        jammed: this.tactical.jammed,
        smokeClouds: this.visibleSmoke.length,
      },
      radar: {
        live: this.tactical.radar.live,
        charges: this.tactical.radar.charges,
        pickups: this.pickups.map((p) => ({ id: p.id, pos: { ...p.pos }, cooldown: p.cooldown })),
      },
      jetpack: {
        mode: m.jet,
        fuel: m.jetFuel,
        thrust: m.jetThrust,
        items: this.jetpacks.map((j) => ({ ...j, pos: { ...j.pos } })),
        fx: this.jet.fx.stats,
      },
      pos: { ...m.pos },
      vel: { ...m.vel },
      grounded: m.grounded,
      crouched: m.crouched,
      sprinting: m.sprinting,
      eyeHeight: m.eyeHeight,
      ammo: w?.ammo ?? -1,
      reserve: w?.reserve ?? -1,
      reloading: (w?.reloadTimer ?? 0) > 0,
      adsAmount: w?.adsAmount ?? 0,
      yaw: this.input.yaw,
      pitch: this.input.pitch,
      stats: { ...this.stats },
      camera: {
        mode: this.director.mode,
        time: this.director.time,
        enabled: this.director.enabled,
        killer: this.director.kill?.killer ?? null,
        pos: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
        localSoldier: this.localSoldier?.root.visible ?? false,
      },
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      shadowTriangles: this.shadowGeometry.triangles,
      shadowDrawCalls: this.shadowGeometry.calls,
      shaderPrograms: this.renderer.info.programs?.length ?? 0,
      gpuTiming: {
        available: this.gpuTimer.available,
        medianMs: Number.isFinite(gpuMedianMs) ? gpuMedianMs : null,
      },
      fps: this.perf.fps,
      quality: this.quality,
      weather: this.appliedWeather,
      resolutionScale: this.resolutionScale,
      overlaps: this.physics.overlapsStatic(m.pos, m.crouched ? 1.2 : 1.8, 0.03),
      online: this.online
        ? {
            status: this.online.status.state,
            id: this.online.id,
            players: this.online.roster.length,
            pending: this.online.pendingCount,
            corrections: this.online.corrections,
            lastError: this.online.lastError,
            rtt: this.online.rtt,
            phase: this.online.match?.phase ?? null,
          }
        : null,
    };
  }

  /** The key currently bound to an action, for prompts. */
  private keyFor(
    action: 'radar' | 'drone' | 'smoke' | 'jammer' | 'jump' | 'crouch' | 'interact' | 'switchSeat',
  ): string {
    const [a, b] = this.settings.keybinds[action];
    return a || b ? keyLabel(a || b) : '—';
  }

  /** Autotest (`__wd.impact`): an impact effect at a point (screenshots; presentation only). */
  debugImpact(point: Vec3, normal: Vec3, surface: SurfaceKind): void {
    this.effects.impact(point, normal, surface);
  }

  /**
   * Autotest (`__wd.tyreDemo`): a presentation-only ghost truck (id `TYRE_DEMO_ID`, the real
   * truck model) driven by the shared vehicle step on the client's own physics world through a
   * fixed script — launch, handbrake drift, straighten, hard brake (`vehicles/tyreDemo.ts`) — so
   * tyre dust and skid marks can be graded on camera. Offline (no trucks on the page) the trucks'
   * view is built on demand here: dev/autotest only, never the sim or the network.
   * `'front'` starts it ~14 m ahead and ~10 m left of the camera, crossing the view left to right
   * with the drift near the middle. Returns true once the ghost is running.
   */
  tyreDemo(x: number | 'front', z = 0, yaw = 0): boolean {
    if (!this.vehiclesView) {
      // Built mid-session: its programs compile on first sight (a dev-only hitch, never in play).
      const built = (this.vehiclesView = new VehiclesView(this.physics));
      this.scene.add(built.group);
      applyLampVolume(built.group, 'world');
      void built
        .useModel(`${import.meta.env.BASE_URL}models/vehicles/truck.glb`)
        .then(() => applyLampVolume(built.group, 'world'));
    }
    let launch: number | undefined;
    if (x === 'front') {
      const forward = this.camera.getWorldDirection(new THREE.Vector3());
      const at = frontStart(this.camera.position, forward);
      x = at.x;
      z = at.z;
      yaw = at.yaw;
      launch = FRONT_LAUNCH;
    }
    // The ground under the start (from just above the camera's height: not a roof overhead).
    const from = { x, y: this.camera.position.y + 1.5, z };
    const hit = this.physics.castGroundRay(from, { x: 0, y: -1, z: 0 }, 60);
    const y = hit?.point.y ?? this.player.move.pos.y;
    this.tyreDemoRun = new TyreDemoRun(x, y, z, yaw, launch);
    return true;
  }

  /** Autotest (`__wd.tyreDemoState`): the ghost's phase, speed, position, blocked; or null. */
  tyreDemoState(): TyreDemoState | null {
    return this.tyreDemoRun?.state() ?? this.tyreDemoLast;
  }

  private tyreDemoRun: TyreDemoRun | null = null;
  private tyreDemoLast: TyreDemoState | null = null;
  private readonly tyreDemoList: DrawnVehicle[] = [];

  private stepTyreDemo(dt: number): DrawnVehicle | null {
    const run = this.tyreDemoRun;
    if (!run) return null;
    run.step(dt, this.physics);
    // Gone once the script is done (its skid marks stay and fade); its last state stays readable.
    if (run.phase === 'done') {
      this.tyreDemoLast = run.state();
      this.tyreDemoRun = null;
      return null;
    }
    return { id: TYRE_DEMO_ID, motion: run.motion, condition: 'active', health: 1 };
  }

  /** Autotest/probes (`__wd.vehicles`): our seat, the tyre effects and the trucks as drawn. */
  vehicleDebug(): {
    seat: { vehicle: number; seat: SeatId } | null;
    /** Live tyre dust particles and laid skid segments (all trucks). */
    tyreFx: { dust: number; skids: number };
    trucks: {
      id: number;
      x: number;
      y: number;
      z: number;
      yaw: number;
      hp: number;
      condition: string;
    }[];
  } {
    const s = this.player.seat;
    return {
      seat: s ? { vehicle: s.vehicle, seat: s.seat } : null,
      tyreFx: this.vehiclesView?.tyres.stats() ?? { dust: 0, skids: 0 },
      trucks: this.drawnVehicles.map((v) => ({
        id: v.id,
        x: v.motion.pos.x,
        y: v.motion.pos.y,
        z: v.motion.pos.z,
        yaw: v.motion.yaw,
        hp: v.hp,
        condition: v.condition,
      })),
    };
  }

  /** Debug (perf bisection): hide/show every object whose name starts with `prefix`. */
  hideMeshes(prefix: string, hidden: boolean): number {
    let n = 0;
    this.scene.traverse((o) => {
      if (o.name.startsWith(prefix)) {
        o.visible = !hidden;
        n++;
      }
    });
    return n;
  }

  /** Debug: meshes in the scene / in the view frustum, grouped by kind (draw-call budgeting). */
  sceneStats(): Record<string, [number, number]> {
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(
        this.camera.projectionMatrix,
        this.camera.matrixWorldInverse,
      ),
    );
    const out: Record<string, [number, number]> = {};
    this.scene.traverseVisible((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const kind = o.name.startsWith('map:')
        ? `map:${o.name.split('|')[0]!.slice(4)}`
        : o.name || o.type;
      const e = (out[kind] ??= [0, 0]);
      e[0]++;
      if (o.frustumCulled === false || frustum.intersectsObject(o)) e[1]++;
    });
    return out;
  }

  /**
   * Autotest hook (`__wd.cam`): play a camera moment now so it can be screenshotted.
   * 'intro' flies the intro (Market only); 'death' offline kills you (by the partner if one is out, else your
   * own frag) — a real death, respawn after the delay or a press; online it previews the kill cam
   * from the nearest other player (presentation only, ends on its own); 'victory' previews the
   * victory shot (the results' winner, else you); 'off' cuts back to first person.
   */
  cam(kind: 'intro' | 'death' | 'victory' | 'off'): string {
    this.cineAllowed = true;
    const d = this.director;
    d.setEnabled(this.cineEnabled);
    if (!d.enabled) return 'disabled (Cinematic cameras is off)';
    if (kind === 'off' || kind === 'intro') {
      // Cut whatever plays back to first person first.
      d.setEnabled(false);
      d.setEnabled(true);
      if (!this.online && this.respawnTimer > 0) this.respawn();
      if (kind === 'off') return d.mode;
      if (!this.introKeys) return 'no intro on this map (Market only)';
      return this.startIntro() ? d.mode : 'not now (dead or flying the drone)';
    }
    if (kind === 'victory') {
      d.startPreview('victory', 8);
      return d.mode;
    }
    if (!this.online) {
      const p = this.partner;
      if (p?.alive) {
        const cause = 'Your sparring partner got you';
        this.damagePlayer(this.player.health, p.state.move.pos, cause, 'partner');
      } else this.damagePlayer(this.player.health, this.player.move.pos);
      return d.mode;
    }
    // Online preview: the kill cam from the nearest other player over the last seconds.
    const me = this.player.move.pos;
    let best: RemotePlayer | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const r of this.online.remotePlayers(this.frameLocalMs)) {
      const dist = Math.hypot(r.pose.x - me.x, r.pose.y - me.y, r.pose.z - me.z);
      if (dist < bestDist) {
        best = r;
        bestDist = dist;
      }
    }
    const now = this.online.serverNow(this.frameLocalMs);
    // Our own recording runs on the server's present, theirs ~a delay behind: end a little back.
    const killMs = now === null ? Number.NaN : now - 300;
    d.startPreview('death', CINE.deathPull + CINE.killcamLength + 0.5, {
      killer: best?.id ?? null,
      killerName: best?.name ?? 'Nobody near',
      weapon: best ? PRIMARIES[best.pose.primary].name : '—',
      distance: best ? bestDist : 0,
      headshot: true,
      killMs,
    });
    if (Number.isFinite(killMs)) this.replay.freeze(killMs + CINE.killcamPostRoll * 1000);
    return d.mode;
  }

  teleport(x: number, y: number, z: number, yaw?: number, pitch?: number): void {
    const p = { x, y, z };
    this.body.setPosition(p);
    this.player.move.pos = { ...p };
    this.player.move.vel = { x: 0, y: 0, z: 0 };
    this.prev = clonePlayerState(this.player);
    if (yaw !== undefined) this.input.yaw = yaw;
    if (pitch !== undefined) this.input.pitch = pitch;
  }
}

/** The tyre demo's ghost truck id (far from the map's trucks, 1…n). */
const TYRE_DEMO_ID = 9001;

/**
 * The driver's chase camera: pivot height over the truck and tilt (m, rad). Distance back and
 * lift are the framings in `vehicles/chaseCamera.ts`.
 */
const CHASE = {
  height: 2.0,
  tilt: -0.06,
  /** The tree fade's line of sight: down from the pivot to the truck's middle, and its radius. */
  fadeDrop: 0.8,
  fadeRadius: 2.2,
  /** Recentring: after this long without mouse look (ms), at this rate (rad/s, at speed). */
  recentreAfterMs: 900,
  recentreRate: 2.4,
  /** The view pitch it settles to (slightly down the road). */
  restPitch: -0.08,
} as const;

/** A truck's motion between two sim steps (render interpolation). */
function lerpMotion(a: VehicleMotion, b: VehicleMotion, t: number): VehicleMotion {
  const l = (x: number, y: number): number => x + (y - x) * t;
  const d = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
  return {
    pos: { x: l(a.pos.x, b.pos.x), y: l(a.pos.y, b.pos.y), z: l(a.pos.z, b.pos.z) },
    vel: { x: l(a.vel.x, b.vel.x), y: l(a.vel.y, b.vel.y), z: l(a.vel.z, b.vel.z) },
    yaw: a.yaw + d * t,
    yawRate: l(a.yawRate, b.yawRate),
    steer: l(a.steer, b.steer),
    pitch: l(a.pitch, b.pitch),
    roll: l(a.roll, b.roll),
    grounded: b.grounded,
  };
}
