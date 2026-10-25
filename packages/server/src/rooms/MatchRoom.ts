import {
  CloseCode,
  ErrorCode,
  Room,
  ServerError,
  type AuthContext,
  type Client,
} from '@colyseus/core';
import {
  ChatSendMessageOrNull,
  DropGunMessageOrNull,
  type DropGunMessage,
  type ChatSendMessage,
  EndMatchMessageOrNull,
  type EndMatchMessage,
  hasAllMatchKeys,
  initPhysics,
  InputMessageOrNull,
  type InputMessage,
  type LobbyErrorMessage,
  MATCH_NET,
  MatchPongOrNull,
  type MatchPing,
  type MatchPong,
  MatchSettingsUpdateOrNull,
  NameMessageOrNull,
  type NameMessage,
  parseMatchOptions,
  QUICK_JOIN_SETTINGS,
  LoadoutMessageOrNull,
  type LoadoutMessage,
  type PrimaryId,
  ReadyMessageOrNull,
  type ReadyMessage,
  type QuickJoinSettings,
  sanitizeName,
  SIM,
  StartMatchMessageOrNull,
  type StartMatchMessage,
  type CombatMessage,
  type DropMessage,
  type LobbyMessage,
  type LobbyPlayer,
  type MatchOptions,
  type MatchSettings,
  type WelcomeMessage,
} from '@wd/shared';
import { MatchSim } from '../match/MatchSim.ts';
import { chatSeed, MatchChat, type ChatSource } from '../match/matchChat.ts';
import { startPacedLoop } from '../match/pacer.ts';
import {
  createLobbyState,
  authorizeLobbyStart,
  commitLobbyStart,
  joinLobby,
  lobbyMessage,
  renameLobbySeat,
  removeLobbySeat,
  setLobbyConnected,
  settingsFromOptions,
  updateLobbySettings,
  type LobbyCommandResult,
  type LobbyState,
} from './lobbyState.ts';
import { rateLimitKey, matchGuard } from './matchGuard.ts';

/** Listing metadata = the matchmaking keys (`filterBy`), copied from the create options. */
export interface MatchMetadata {
  lobby: boolean;
  map: string;
  size: string;
  mode: string;
}

/**
 * What `onAuth` hands `onJoin` (Colyseus keeps it as `client.auth`): whether the seat came from
 * matchmaking (create / join / joinOrCreate) rather than a share link (`joinById`).
 */
export interface MatchAuth {
  matchmade: boolean;
}

/**
 * The matchmaking method of an HTTP matchmaking request (`/matchmake/<method>/<room>`), or null
 * when the context carries no request (then it is treated as matchmaking: the strict case).
 */
export function matchmakeMethod(context: Pick<AuthContext, 'req'>): string | null {
  const req: unknown = context.req;
  const url =
    typeof req === 'object' && req !== null && 'url' in req && typeof req.url === 'string'
      ? req.url
      : null;
  return url ? (/\/matchmake\/([^/?#]+)\//.exec(url)?.[1] ?? null) : null;
}

/**
 * Whether a seat may take this room: quick-join rooms only take joiners asking for exactly their
 * keys (Colyseus matches only the keys a request sends; this is the backstop), and friend lobbies
 * are never matchmade into (they are private; this is the backstop too), only joined by link.
 * The creator's own seat (`first`) is the one matchmade seat a lobby takes.
 */
export function seatFitsRoom(
  room: MatchMetadata,
  seat: Pick<MatchOptions, 'lobby' | 'map' | 'size' | 'mode'>,
  auth: MatchAuth | undefined,
  first: boolean,
): boolean {
  if (room.lobby) return first || !auth?.matchmade;
  return !seat.lobby && seat.map === room.map && seat.size === room.size && seat.mode === room.mode;
}

/** Seconds the creator has to connect before a room nobody joined is disposed. */
const FIRST_SEAT_SECONDS = 10;
/** Seconds later joiners have (a slow device can block its main thread for a while). */
const SEAT_SECONDS = 30;

/**
 * Authoritative online match. Clients send inputs only — never positions or hits. The room
 * steps every player with the shared `stepPlayer` at 60 Hz, resolves every shot, strike and
 * blast itself (lag-compensated, see `MatchSim`), and sends snapshots at 30 Hz; clients predict
 * themselves and interpolate everyone else.
 *
 * Messages: `input`, `name`, `pong`, `ready` (client → server, valibot-validated; anything invalid kicks
 * the sender), `welcome` / `roster` / `snap` / `respawn` / `combat` / `match` / `ping`
 * (server → client, see `shared/net/protocol.ts`).
 */
export class MatchRoom extends Room<{ metadata: MatchMetadata }> {
  override maxClients = MATCH_NET.maxPlayers;
  override maxMessagesPerSecond = MATCH_NET.maxMessagesPerSecond;
  // A create that never connects frees its room quickly; raised once someone is in.
  override seatReservationTimeout = FIRST_SEAT_SECONDS;
  // Snapshots are plain messages (no Colyseus schema state), so no state patches.
  override patchRate = null;

  /** Matchmaking requests already counted against the rate (see `onAuth`). */
  private static readonly charged = new WeakSet<object>();

  private sim: MatchSim | undefined;
  /** The room's chat: the lobby's, then the match's (players' lines + bot chatter). */
  private chat: MatchChat | null = null;

  /** Who may chat: the match's players once it runs, the lobby's seats before (room clock). */
  private chatSource(): ChatSource {
    return {
      sender: (id) => {
        const p = this.sim?.players.get(id);
        if (p) return { name: p.name, slot: p.slot, bot: p.bot };
        const seats = this.lobby?.seats;
        const seat = seats?.get(id);
        return seat && seats
          ? { name: seat.name, slot: [...seats.keys()].indexOf(id), bot: false }
          : null;
      },
      now: () => this.clock.currentTime,
    };
  }
  private lobby: LobbyState | undefined;
  /** This room's matchmaking keys, fixed at create (seats must fit them, see `seatFitsRoom`). */
  private keys: MatchMetadata | undefined;
  /** Sessions sent a `welcome` for the running match (lazy: test stubs skip the constructor). */
  private welcomed: Set<string> | undefined;
  /** Each player's loadout primary (from join options; changed by `loadout` messages). */
  private primaries: Map<string, PrimaryId> | undefined;
  private get primaryOf(): Map<string, PrimaryId> {
    return (this.primaries ??= new Map());
  }

  private get welcomedIds(): Set<string> {
    return (this.welcomed ??= new Set());
  }
  /** Someone has taken a seat (the creator's is the only matchmade seat a lobby accepts). */
  private seated = false;
  /** This room holds one of `matchGuard`'s room slots (released on dispose). */
  private holdsSlot = false;
  private startedLoop = false;
  private stopLoop: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  private disposed = false;

  /**
   * Every matchmaking request (create, join, joinOrCreate, joinById) passes here first: over-rate
   * clients and invalid options are refused before any room is built, and so is matchmaking
   * without every room key (Colyseus filters only on the keys sent: `{}` would match any public
   * room). `ServerError`s are answered without being logged (a hostile client can't flood the log).
   */
  static override onAuth(
    _token: string,
    options: unknown,
    context: AuthContext,
  ): Promise<MatchAuth> {
    // Colyseus retries a join that lost a seat race with the same context: charge it once.
    const charged = MatchRoom.charged.has(context);
    MatchRoom.charged.add(context);
    if (!charged && !matchGuard.allowRequest(rateLimitKey(context), performance.now())) {
      return Promise.reject(new ServerError(ErrorCode.AUTH_FAILED, 'too many requests'));
    }
    if (!parseMatchOptions(options)) {
      return Promise.reject(
        new ServerError(ErrorCode.MATCHMAKE_INVALID_CRITERIA, 'invalid match options'),
      );
    }
    const matchmade = matchmakeMethod(context) !== 'joinById';
    if (matchmade && !hasAllMatchKeys(options)) {
      return Promise.reject(
        new ServerError(
          ErrorCode.MATCHMAKE_INVALID_CRITERIA,
          'invalid match options: lobby, map, size and mode are required',
        ),
      );
    }
    return Promise.resolve({ matchmade });
  }

  /**
   * The settings of every quick-join match on this server (`createGameServer` can override them,
   * e.g. tests without bots). Never taken from the client.
   */
  protected quickJoinSettings(): QuickJoinSettings {
    return QUICK_JOIN_SETTINGS;
  }

  override async onCreate(options: unknown): Promise<void> {
    const parsed = parseMatchOptions(options);
    if (!parsed) throw new ServerError(ErrorCode.MATCHMAKE_INVALID_CRITERIA, 'invalid options');
    // Each match builds a physics world: a hard cap on live matches (denial of service).
    if (!matchGuard.openRoom()) {
      throw new ServerError(ErrorCode.MATCHMAKE_UNHANDLED, 'server full: too many matches');
    }
    this.holdsSlot = true;
    this.disposed = false;
    // Quick join: the creator picks only the keys; everything else is the server's.
    const effective: MatchOptions = parsed.lobby
      ? parsed
      : { ...parsed, ...this.quickJoinSettings() };
    this.lobby = createLobbyState(effective);
    this.keys = {
      lobby: parsed.lobby,
      map: parsed.map,
      size: parsed.size,
      mode: parsed.mode,
    };
    this.metadata = { ...this.keys };
    // Friend lobbies are joined by share link only: never listed, never matchmade into. Set
    // before the room is first persisted (after onCreate), so no search ever sees it public.
    if (parsed.lobby) await this.setPrivate(true);

    // Validated by valibot; anything invalid (also sent as a `room.request`) kicks the sender.
    this.onMessage('input', InputMessageOrNull, (client: Client, msg: InputMessage | null) => {
      if (msg === null) {
        client.leave(CloseCode.WITH_ERROR);
        return;
      }
      this.sim?.receiveInputs(client.sessionId, msg.inputs, this.clock.currentTime);
    });
    // Name edits made after joining (rate limited in the sim; sanitized like the join name).
    this.onMessage('name', NameMessageOrNull, (client: Client, msg: NameMessage | null) => {
      if (msg === null) {
        client.leave(CloseCode.WITH_ERROR);
        return;
      }
      const sim = this.sim;
      if (sim) {
        if (sim.rename(client.sessionId, msg.name, this.clock.currentTime)) {
          const renamed = sim.players.get(client.sessionId);
          const seat = this.lobby?.seats.get(client.sessionId);
          if (renamed && seat) seat.name = renamed.name;
          this.broadcast('roster', sim.roster());
          this.broadcastLobby();
        }
        return;
      }
      const seat = this.lobby?.seats.get(client.sessionId);
      if (!seat) return;
      if (renameLobbySeat(this.matchLobby, client.sessionId, msg.name, this.clock.currentTime)) {
        this.broadcastLobby();
      }
    });
    // Loadout: the next life's primary (ground swaps change only the current life).
    this.onMessage(
      'loadout',
      LoadoutMessageOrNull,
      (client: Client, msg: LoadoutMessage | null) => {
        if (msg === null) {
          client.leave(CloseCode.WITH_ERROR);
          return;
        }
        this.primaryOf.set(client.sessionId, msg.primary);
        this.sim?.setLoadout(client.sessionId, msg.primary);
      },
    );
    // Hosted production matches never register the development/autotest spawn command.
    if (process.env.NODE_ENV !== 'production') {
      this.onMessage(
        'dropGun',
        DropGunMessageOrNull,
        (client: Client, msg: DropGunMessage | null) => {
          if (msg === null) {
            client.leave(CloseCode.WITH_ERROR);
            return;
          }
          const sim = this.sim;
          if (sim?.players.has(client.sessionId))
            sim.spawnWeaponDrop(msg.primaryId, msg.x, msg.z, msg.ammoFraction);
        },
      );
    }
    // Friend lobbies: the client built and warmed up its game, so it joins the fight now.
    this.onMessage('ready', ReadyMessageOrNull, (client: Client, msg: ReadyMessage | null) => {
      if (msg === null) {
        client.leave(CloseCode.WITH_ERROR);
        return;
      }
      this.sim?.markReady(client.sessionId);
    });
    // Round trip: the echo of our own `ping` (the rewind cap's RTT, and the badge). Only the
    // echo of a ping this room sent that player and that is still outstanding counts, once: a
    // forged, replayed or stale stamp is ignored (it is well-formed, so nobody is kicked for it).
    this.onMessage('pong', MatchPongOrNull, (client: Client, msg: MatchPong | null) => {
      if (msg === null) {
        client.leave(CloseCode.WITH_ERROR);
        return;
      }
      this.sim?.receivePong(client.sessionId, msg.t, performance.now());
    });
    this.onMessage('settings', MatchSettingsUpdateOrNull, (client, msg) => {
      if (this.starting) {
        this.sendLobbyError(client, 'already-started', 'match already starting');
        return;
      }
      this.replyLobbyCommand(
        client,
        msg ? updateLobbySettings(this.matchLobby, client.sessionId, msg, this.roomId) : null,
      );
    });
    this.onMessage('start', StartMatchMessageOrNull, (client, msg: StartMatchMessage | null) => {
      if (msg === null) {
        this.sendLobbyError(client, 'invalid-settings', 'invalid start request');
        return;
      }
      void this.startFromHost(client);
    });
    // Host-only: end the running match now (a match with no limits ends only this way).
    this.onMessage('end', EndMatchMessageOrNull, (client, msg: EndMatchMessage | null) => {
      if (msg === null) {
        this.sendLobbyError(client, 'invalid-settings', 'invalid end request');
        return;
      }
      this.endFromHost(client);
    });
    // Chat (lobby and match): a quick-chat preset or a line of text (cleaned and rate limited
    // in MatchChat). Bots only talk once the match runs.
    this.chat = new MatchChat(this.chatSource(), {
      seed: chatSeed(this.roomId ?? ''),
      botChatter: this.lobby.settings.botChatter !== 'off',
    });
    this.onMessage('chat', ChatSendMessageOrNull, (client, msg: ChatSendMessage | null) => {
      if (msg === null) {
        client.leave(CloseCode.WITH_ERROR);
        return;
      }
      const out = this.chat?.fromPlayer(client.sessionId, msg);
      if (out?.all) this.broadcast('chat', out.all);
      if (out?.sender) client.send('chat', out.sender);
    });
    this.clock.setInterval(() => {
      const sim = this.sim;
      if (!sim) return;
      for (const c of this.clients) {
        // Stamped per player with the high-resolution clock: the stamp is also the nonce.
        const ping: MatchPing | null = sim.issuePing(c.sessionId, performance.now());
        if (ping) c.send('ping', ping);
      }
    }, MATCH_NET.pingIntervalMs);

    if (!parsed.lobby) await this.startPlaying(effective);
  }

  private get match(): MatchSim {
    if (!this.sim) throw new ServerError(ErrorCode.MATCHMAKE_UNHANDLED, 'match not ready');
    return this.sim;
  }

  private get matchLobby(): LobbyState {
    if (!this.lobby) throw new ServerError(ErrorCode.MATCHMAKE_UNHANDLED, 'lobby not ready');
    return this.lobby;
  }

  override onJoin(client: Client, options: unknown, auth?: MatchAuth): void {
    const parsed = parseMatchOptions(options);
    if (!parsed) throw new ServerError(ErrorCode.MATCHMAKE_INVALID_CRITERIA, 'invalid options');
    if (this.keys && !seatFitsRoom(this.keys, parsed, auth, !this.seated)) {
      throw new ServerError(ErrorCode.MATCHMAKE_INVALID_CRITERIA, 'options do not fit this room');
    }
    this.seated = true;
    this.seatReservationTimeout = SEAT_SECONDS;
    const lobby = this.matchLobby;
    const fallback = `Player ${lobby.seats.size + 1}`;
    const name = sanitizeName(parsed.name, fallback);
    this.primaryOf.set(client.sessionId, parsed.primary ?? 'ar7');
    joinLobby(lobby, client.sessionId, name, this.clock.currentTime);
    this.broadcastLobby();
    if (lobby.phase === 'lobby') return;
    if (!this.sim) return;
    this.joinPlaying(client);
  }

  private joinPlaying(client: Client): void {
    const sim = this.match;
    const seat = this.matchLobby.seats.get(client.sessionId);
    const fallback = `Player ${sim.players.size + 1}`;
    // A friend-lobby client builds its game only now: out of the fight until it is `ready`.
    sim.addPlayer(client.sessionId, seat?.name ?? fallback, this.clock.currentTime, false, {
      ready: this.keys?.lobby !== true,
      primary: this.primaryOf.get(client.sessionId),
    });
    this.sendWelcome(client);
    this.broadcast('roster', sim.roster());
    // The joiner needs the score and clock now; everyone else gets the new scoreboard row.
    sim.takeMatchChange();
    this.broadcast('match', sim.matchState());
  }

  /**
   * Joiners and reconnecting clients missed throws that are still dangerous now, and every prop a
   * truck moved or smashed this match.
   */
  private restoreGrenades(client: Client): void {
    client.send('combat', { events: this.match.props.restore() } satisfies CombatMessage);
    const events: CombatMessage['events'] = this.match.grenades.map(({ g, owner }) => ({
      type: 'nade',
      id: g.id,
      by: owner,
      pos: { ...g.pos },
      vel: { ...g.vel },
      fuse: g.fuse,
      kind: g.kind,
      resting: g.resting,
    }));
    if (events.length) client.send('combat', { events } satisfies CombatMessage);
  }

  /** Connection lost without consent: keep the seat (and the body) for a while. */
  override onDrop(client: Client, code?: number): void {
    // Kicked by the server (invalid payload, message flood): no seat to come back to. Returning
    // without `allowReconnection` makes Colyseus call `onLeave` right away.
    if (code === CloseCode.WITH_ERROR || code === CloseCode.SERVER_SHUTDOWN) return;
    const sim = this.sim;
    if (!sim) {
      setLobbyConnected(this.matchLobby, client.sessionId, false);
      this.broadcastLobby();
      Promise.resolve(this.allowReconnection(client, MATCH_NET.reconnectSeconds)).catch(() => {});
      return;
    }
    const p = sim.players.get(client.sessionId);
    if (p) p.connected = false;
    setLobbyConnected(this.matchLobby, client.sessionId, false);
    this.broadcast('roster', sim.roster());
    this.broadcastLobby();
    // If the seat expires, Colyseus calls onLeave (which removes the body).
    // (It rejects when the seat expires or the room is disposing; nothing to do then.)
    Promise.resolve(this.allowReconnection(client, MATCH_NET.reconnectSeconds)).catch(() => {});
  }

  override onReconnect(client: Client): void {
    const sim = this.sim;
    setLobbyConnected(this.matchLobby, client.sessionId, true);
    if (!sim) {
      this.broadcastLobby();
      return;
    }
    if (!sim.players.has(client.sessionId)) {
      this.joinPlaying(client);
      return;
    }
    const p = sim.players.get(client.sessionId);
    if (p) p.connected = true;
    if (!this.welcomedIds.has(client.sessionId)) {
      // Dropped in the lobby, back after the start: the start-time welcome only reached the
      // connected clients, so this one is still waiting for it (with the grenades in flight).
      this.sendWelcome(client);
    } else {
      // A respawn while away: the client needs its boundary to rebuild the new life.
      if (p?.lastRespawn) client.send('respawn', p.lastRespawn);
      this.restoreGrenades(client);
    }
    this.broadcast('roster', sim.roster());
    this.broadcastLobby();
    client.send('match', sim.matchState());
  }

  override onLeave(client: Client): void {
    const sim = this.sim;
    if (sim) {
      sim.removePlayer(client.sessionId);
      this.broadcast('roster', sim.roster());
    }
    // Lobby guests chat too: their rate-limit state goes whether or not a match ever ran.
    this.chat?.remove(client.sessionId);
    removeLobbySeat(this.matchLobby, client.sessionId);
    this.welcomedIds.delete(client.sessionId);
    this.broadcastLobby();
  }

  /** Also runs when `onCreate` threw (Colyseus disposes the half-built room). */
  override onDispose(): void {
    this.disposed = true;
    this.stopLoop?.();
    this.stopLoop = null;
    this.sim?.dispose();
    this.sim = undefined;
    this.chat = null;
    if (this.holdsSlot) matchGuard.closeRoom();
    this.holdsSlot = false;
  }

  private async startFromHost(client: Client): Promise<void> {
    const result = authorizeLobbyStart(this.matchLobby, client.sessionId);
    if (!result.ok) {
      this.replyLobbyCommand(client, result);
      return;
    }
    try {
      await this.startPlaying();
      if (this.disposed) return;
      commitLobbyStart(this.matchLobby, this.roomId);
      this.broadcastLobby();
    } catch {
      this.disposeStartingSim();
      this.starting = null;
      this.sendLobbyError(client, 'invalid-settings', 'could not start match');
    }
  }

  /**
   * The host's `end`: the normal results (and shared-win rule) now. Only the host of a started
   * friend room (quick-join matches with strangers have fixed limits and nobody may cut them
   * short), only while a match is being played (not during the results).
   */
  private endFromHost(client: Client): void {
    const lobby = this.matchLobby;
    const sim = this.sim;
    if (lobby.phase !== 'playing' || !sim || this.keys?.lobby !== true) {
      this.sendLobbyError(client, 'not-lobby', 'match is not running');
      return;
    }
    if (client.sessionId !== lobby.hostId) {
      this.sendLobbyError(client, 'host-only', 'only the host can end the match');
      return;
    }
    if (!sim.endMatch()) return;
    const match = sim.takeMatchChange();
    if (match) this.broadcast('match', match);
  }

  private async startPlaying(options?: MatchOptions): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await initPhysics();
      if (this.disposed) throw new Error('room disposed while starting');
      const settings = options ? settingsFromOptions(options) : this.matchLobby.settings;
      this.matchLobby.settings = settings;
      let sim: MatchSim | null = null;
      try {
        sim = new MatchSim({ ...settings, spawnSeed: Math.floor(Math.random() * 0x100000000) });
        // Bots' nav graph is built here, before the 60 Hz loop, never inside a tick.
        if (settings.botCount > 0) sim.bots.prewarm();
        this.syncLobbySeatsIntoSim(sim);
      } catch (err) {
        sim?.dispose();
        throw err;
      }
      if (this.disposed) {
        sim.dispose();
        throw new Error('room disposed while starting');
      }
      this.sim = sim;
      if (this.chat) {
        this.chat.chatter.enabled = settings.botChatter !== 'off';
        this.chat.forgetHeard();
      }
      await this.updateMatchmakingMetadata(options, settings);
      if (this.disposed) {
        if (this.sim === sim) {
          this.sim = undefined;
          sim.dispose();
        }
        throw new Error('room disposed while starting');
      }
      this.syncLobbySeatsIntoSim(sim);
      // Sent before the next snapshot, so the client rebuilds the new life first.
      sim.onRespawn = (p, msg) => this.clients.getById(p.id)?.send('respawn', msg);
      this.sendWelcomeToConnectedClients();
      this.broadcast('roster', sim.roster());
      sim.takeMatchChange();
      this.broadcast('match', sim.matchState());
      this.startSimulationLoop();
    })();
    await this.starting;
  }

  private syncLobbySeatsIntoSim(sim: MatchSim): void {
    for (const seat of this.matchLobby.seats.values()) {
      // Everyone starts building their game at the start: out of the fight until `ready`.
      const player = sim.addPlayer(seat.id, seat.name, this.clock.currentTime, false, {
        ready: false,
        primary: this.primaryOf.get(seat.id),
      });
      player.connected = seat.connected;
    }
  }

  private sendWelcomeToConnectedClients(): void {
    for (const c of this.clients) this.sendWelcome(c);
  }

  private disposeStartingSim(): void {
    const sim = this.sim;
    if (!sim) return;
    this.sim = undefined;
    sim.dispose();
  }

  private async updateMatchmakingMetadata(
    options: MatchOptions | undefined,
    settings: MatchSettings,
  ): Promise<void> {
    await this.setMatchmaking({
      metadata: {
        lobby: options?.lobby ?? true,
        map: settings.map,
        size: settings.size,
        mode: settings.mode,
      },
    });
  }

  private sendWelcome(client: Client): void {
    const sim = this.match;
    const p = sim.players.get(client.sessionId);
    if (!p) return;
    const pos = p.state.move.pos;
    const welcome: WelcomeMessage = {
      id: p.id,
      map: sim.config.map,
      size: sim.config.size,
      mode: sim.config.mode,
      settings: this.matchLobby.settings,
      tick: sim.tick,
      tickHz: SIM.tickHz,
      spawn: { x: pos.x, y: pos.y, z: pos.z, yaw: p.state.view.yaw },
      seed: p.seed,
      primary: p.state.arsenal.primary,
    };
    client.send('welcome', welcome);
    this.welcomedIds.add(client.sessionId);
    this.restoreGrenades(client);
  }

  private startSimulationLoop(): void {
    if (this.startedLoop) return;
    this.startedLoop = true;
    this.stopLoop = this.runPacedLoop((ticks, snapshot) => {
      const sim = this.sim;
      if (!sim) return;
      sim.runTicks(ticks);
      // Combat first (a kill before the snapshot that shows the body gone), then the score.
      const events = sim.drainEvents();
      if (events.length) this.broadcast('combat', { events });
      const drops = sim.drainDrops();
      if (drops.length) this.broadcast('drop', { events: drops } satisfies DropMessage);
      const match = sim.takeMatchChange();
      if (match) this.broadcast('match', match);
      // Bots' chatter reads the step (it never feeds back into the sim).
      for (const line of this.chat?.afterStep(sim, events) ?? []) this.broadcast('chat', line);
      // Each client gets its own snapshot: its entry carries its weapon and kit state.
      if (snapshot) for (const c of this.clients) c.send('snap', sim.snapshot(c.sessionId));
    });
  }

  /**
   * The 60 Hz sim + 30 Hz snapshot loop (`match/pacer.ts`): whole ticks of measured real time
   * per wake-up (so the tick count, and with it the snapshot time clients interpolate on,
   * follows the wall clock), and snapshots sent on an even cadence at their ticks' absolute
   * times despite coarse timers (Windows: 15.6 ms), with a bounded ≤ 1.5 ms busy-wait. A
   * method so tests can stub it.
   */
  protected runPacedLoop(onStep: (ticks: number, snapshot: boolean) => void): () => void {
    return startPacedLoop(
      {
        stepMs: 1000 / SIM.tickHz,
        snapshotEvery: MATCH_NET.snapshotEvery,
        maxPerCall: MATCH_NET.maxCatchUpTicks,
        maxBacklogMs: MATCH_NET.maxCatchUpMs,
        spinMs: MATCH_NET.snapshotSpinMs,
        maxLeadMs: MATCH_NET.snapshotMaxLeadMs,
        minGapRatio: MATCH_NET.snapshotMinGapRatio,
      },
      onStep,
    );
  }

  private replyLobbyCommand(client: Client, result: LobbyCommandResult | null): void {
    if (!result) {
      this.sendLobbyError(client, 'invalid-settings', 'invalid lobby settings');
      return;
    }
    if (result.ok) this.broadcast('lobby', result.message);
    else this.sendLobbyError(client, result.code, result.message);
  }

  private broadcastLobby(): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const msg: LobbyMessage = lobbyMessage(lobby, this.roomId, this.lobbyBotPlayers());
    this.broadcast('lobby', msg);
  }

  private lobbyBotPlayers(): LobbyPlayer[] {
    const sim = this.sim;
    if (!sim) return [];
    return sim
      .roster()
      .players.filter((p) => p.bot)
      .map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        bot: true,
      }));
  }

  private sendLobbyError(client: Client, code: LobbyErrorMessage['code'], message: string): void {
    client.send('lobbyError', { code, message } satisfies LobbyErrorMessage);
  }
}
