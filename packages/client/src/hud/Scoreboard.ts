/**
 * The hold-Tab scoreboard (online, practice and the offline range): everyone sorted by score,
 * your row highlighted, the match's target and clock in the header. Rows are computed by the
 * pure `scoreboardRows` (tested); the DOM is written only when what it shows changes.
 */

export interface ScoreboardPlayer {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  bot: boolean;
  /** Round trip (ms) for humans; null = unknown (or this page, offline). */
  ping: number | null;
  /** A bot's personality label ("Rusher"), shown beside the BOT tag. */
  persona?: string;
  connected?: boolean;
}

export interface ScoreboardRow extends ScoreboardPlayer {
  /** 1-based place; players level on kills and deaths share it. */
  rank: number;
  /** Shares its place with someone else (shown as "=2"). */
  tied: boolean;
  me: boolean;
}

/**
 * Sorted like the match decides winners (`matchWinners`): most kills, then fewest deaths; level
 * players share a place (the next place skips: 1, =2, =2, 4). Within a tie: you first, then
 * humans before bots, then by name, so the order never flickers between updates.
 */
export function scoreboardRows(players: readonly ScoreboardPlayer[], me: string): ScoreboardRow[] {
  const sorted = [...players].sort(
    (a, b) =>
      b.kills - a.kills ||
      a.deaths - b.deaths ||
      Number(b.id === me) - Number(a.id === me) ||
      Number(a.bot) - Number(b.bot) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  const level = (a: ScoreboardPlayer, b: ScoreboardPlayer): boolean =>
    a.kills === b.kills && a.deaths === b.deaths;
  return sorted.map((p, i) => {
    let first = i;
    while (first > 0 && level(sorted[first - 1]!, p)) first--;
    const tied =
      (i > 0 && level(sorted[i - 1]!, p)) || (i + 1 < sorted.length && level(sorted[i + 1]!, p));
    return { ...p, rank: first + 1, tied, me: p.id === me };
  });
}

/** What the ping column shows: BOT for bots, "—" when unknown, else the round trip. */
export function pingLabel(p: Pick<ScoreboardPlayer, 'bot' | 'ping'>): string {
  if (p.bot) return 'BOT';
  return p.ping === null || p.ping < 0 ? '—' : `${Math.round(p.ping)}`;
}

export interface ScoreboardView {
  /** "FREE FOR ALL · MARKET" */
  title: string;
  /** "First to 25 · 7:42" or the result while the results show. */
  goal: string;
  players: readonly ScoreboardPlayer[];
  me: string;
  /** Chat mutes (the rows show it); with `muteKeys`, everyone else's row gets a number key. */
  muted?: ReadonlySet<string>;
  muteKeys?: boolean;
}

/**
 * The number key (1–6, in row order) that mutes/unmutes each other player, by id: everyone but
 * you, top to bottom.
 */
export function muteKeyIds(rows: readonly ScoreboardRow[]): string[] {
  return rows
    .filter((r) => !r.me)
    .map((r) => r.id)
    .slice(0, 6);
}

export class Scoreboard {
  private readonly root = document.createElement('div');
  private readonly title = document.createElement('div');
  private readonly goal = document.createElement('div');
  private readonly body = document.createElement('div');
  private shown = false;
  private key = '';
  private keyIds: string[] = [];
  private readonly foot = document.createElement('div');

  constructor(parent: HTMLElement) {
    this.root.className = 'scoreboard';
    this.root.dataset.testid = 'scoreboard';
    const head = document.createElement('div');
    head.className = 'sb-head';
    this.title.className = 'sb-title';
    this.goal.className = 'sb-goal';
    this.goal.dataset.testid = 'scoreboard-goal';
    head.append(this.title, this.goal);
    const cols = document.createElement('div');
    cols.className = 'sb-row sb-cols';
    for (const [cls, text] of [
      ['sb-rank', '#'],
      ['sb-name', 'PLAYER'],
      ['sb-num', 'K'],
      ['sb-num', 'D'],
      ['sb-ping', 'PING'],
    ] as const) {
      const c = document.createElement('span');
      c.className = cls;
      c.textContent = text;
      cols.append(c);
    }
    this.body.className = 'sb-body';
    this.foot.className = 'sb-foot';
    this.root.append(head, cols, this.body, this.foot);
    parent.append(this.root);
  }

  get visible(): boolean {
    return this.shown;
  }

  /** The player a mute key (1-based) points at while the board is up (null: none). */
  idForKey(n: number): string | null {
    return this.shown ? (this.keyIds[n - 1] ?? null) : null;
  }

  /** Show (with this content) or hide. Cheap to call every frame. */
  update(view: ScoreboardView | null): void {
    const show = view !== null;
    if (show !== this.shown) {
      this.shown = show;
      this.root.classList.toggle('on', show);
    }
    if (!view) return;
    const rows = scoreboardRows(view.players, view.me);
    const keyIds = view.muteKeys ? muteKeyIds(rows) : [];
    const muted = [...(view.muted ?? [])].sort();
    const key = JSON.stringify([view.title, view.goal, rows, keyIds, muted]);
    if (key === this.key) return;
    this.key = key;
    this.keyIds = keyIds;
    this.title.textContent = view.title;
    this.goal.textContent = view.goal;
    const mutedSet = new Set(muted);
    this.body.replaceChildren(
      ...rows.map((r) => this.row(r, keyIds.indexOf(r.id) + 1, mutedSet.has(r.id))),
    );
    this.foot.textContent = keyIds.length ? `1–${keyIds.length} mute / unmute a player's chat` : '';
  }

  private row(r: ScoreboardRow, muteKey = 0, muted = false): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `sb-row${r.me ? ' me' : ''}${r.bot ? ' bot' : ''}${r.connected === false ? ' away' : ''}`;
    el.dataset.testid = r.me ? 'scoreboard-me' : 'scoreboard-row';
    const cell = (cls: string, text: string): HTMLSpanElement => {
      const c = document.createElement('span');
      c.className = cls;
      c.textContent = text;
      el.append(c);
      return c;
    };
    cell('sb-rank', `${r.tied ? '=' : ''}${r.rank}`);
    const name = cell('sb-name', '');
    if (muteKey > 0) {
      const k = document.createElement('kbd');
      k.className = 'sb-key';
      k.textContent = String(muteKey);
      name.append(k);
    }
    name.append(r.name);
    if (muted) {
      el.classList.add('muted');
      const m = document.createElement('em');
      m.className = 'sb-muted';
      m.textContent = 'MUTED';
      name.append(m);
    }
    if (r.persona) {
      const tag = document.createElement('em');
      tag.className = 'sb-persona';
      tag.textContent = r.persona;
      name.append(tag);
    }
    cell('sb-num', String(r.kills));
    cell('sb-num', String(r.deaths));
    cell(`sb-ping${r.bot ? ' sb-bot' : ''}`, pingLabel(r));
    return el;
  }
}
