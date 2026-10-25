import { matchLine } from './combatFeed.ts';
import { netIndicator, PAGE_HITCH_MS, type NetLevel } from './netIndicator.ts';
import { rosterDisplayName, type OnlineSession } from './onlineSession.ts';

/** Status line for an online match: connection state, round trip and who is in it. */
export function onlineStatusText(session: OnlineSession, label?: string): string {
  const s = session.status;
  // A practice match vs bots: no network, no friends to wait for.
  if (label) return s.state === 'offline' ? `${label} · stopped (${s.error})` : label;
  if (s.state === 'idle') return 'online: press Play to join the match';
  if (s.state === 'connecting') return 'online: joining match…';
  if (s.state === 'reconnecting') return 'online: connection lost, reconnecting…';
  if (s.state === 'offline') return `online: offline (${s.error})`;
  const others = session.roster.filter((p) => p.id !== session.id);
  const names = others.map((p) =>
    p.connected ? rosterDisplayName(p) : `${rosterDisplayName(p)} (away)`,
  );
  const ping = session.rtt >= 0 ? ` · ${session.rtt} ms` : '';
  return names.length
    ? `online${ping} · ${names.length + 1} players: you, ${names.join(', ')}`
    : `online${ping} · waiting for friends to join`;
}

/** Kill-feed lines shown at once, and how long each stays (s). */
const FEED_LINES = 4;
const FEED_SECONDS = 5;

const box = (el: HTMLElement, style: Partial<CSSStyleDeclaration>): void => {
  Object.assign(el.style, {
    position: 'absolute',
    font: '12px system-ui, sans-serif',
    color: '#e8ecf1',
    pointerEvents: 'none',
    textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)',
    ...style,
  });
};

const NET_COLOURS: Record<NetLevel, string> = {
  good: '#7ee0a1',
  fair: '#f2c14e',
  poor: '#ff6b5e',
};

/**
 * The online HUD: a status badge (top right: connection, round trip, players), the network
 * indicator under it (ping, and a warning when the link stalls or jitters: it's the network),
 * the match line (top centre: your score, the best other, the goal, the clock, or the result)
 * and a kill feed under those. DOM only; updated a few times a second, written only on change.
 */
export class OnlineBadge {
  private readonly el = document.createElement('div');
  private readonly net = document.createElement('div');
  private readonly netPing = document.createElement('span');
  private readonly netWarn = document.createElement('span');
  private readonly score = document.createElement('div');
  private readonly feedEl = document.createElement('div');
  private readonly feed: { el: HTMLDivElement; life: number }[] = [];
  private text = '';
  private netText = '';
  private readonly hitches: { at: number; ms: number }[] = [];
  private lastFrameAt: number | null = null;
  private scoreText = '';
  private timer = 0;

  /** `label`: a practice match's status line instead of the connection's (no network badge). */
  constructor(
    parent: HTMLElement,
    private readonly label?: string,
  ) {
    this.el.dataset.testid = 'online-status';
    box(this.el, {
      top: '28px',
      right: '12px',
      padding: '4px 10px',
      background: 'rgba(10, 12, 16, 0.55)',
      borderRadius: '4px',
      maxWidth: '40vw',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      textShadow: 'none',
    });
    this.score.dataset.testid = 'match-score';
    box(this.score, {
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '4px 12px',
      font: '600 13px system-ui, sans-serif',
      letterSpacing: '0.04em',
      background: 'rgba(10, 12, 16, 0.45)',
      borderRadius: '4px',
      whiteSpace: 'nowrap',
    });
    this.score.style.display = 'none';
    this.net.dataset.testid = 'net-indicator';
    box(this.net, {
      top: '54px',
      right: '12px',
      padding: '2px 8px',
      font: '600 11px ui-monospace, monospace',
      letterSpacing: '0.04em',
      background: 'rgba(10, 12, 16, 0.5)',
      borderRadius: '3px',
      whiteSpace: 'nowrap',
      display: 'none',
    });
    this.netWarn.style.marginLeft = '8px';
    this.net.append(this.netPing, this.netWarn);
    this.feedEl.dataset.testid = 'kill-feed';
    box(this.feedEl, {
      top: '78px',
      right: '12px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: '3px',
    });
    parent.append(this.el, this.net, this.score, this.feedEl);
  }

  /** Add a kill-feed line (the oldest goes when full). */
  pushFeed(text: string, mine: boolean): void {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      padding: '2px 8px',
      borderRadius: '3px',
      background: mine ? 'rgba(160, 40, 36, 0.6)' : 'rgba(10, 12, 16, 0.5)',
      transition: 'opacity 0.4s',
    });
    this.feedEl.append(el);
    this.feed.push({ el, life: FEED_SECONDS });
    while (this.feed.length > FEED_LINES) this.feed.shift()!.el.remove();
  }

  update(dt: number, session: OnlineSession, localMs: number): void {
    // Long frames in the last 10 s (messages wait for the page): not the network's fault. Real
    // time between calls, not `dt` (the game clamps that).
    const frameMs = this.lastFrameAt === null ? 0 : localMs - this.lastFrameAt;
    this.lastFrameAt = localMs;
    if (frameMs >= PAGE_HITCH_MS) this.hitches.push({ at: localMs, ms: frameMs });
    while (this.hitches.length && this.hitches[0]!.at < localMs - 10_000) this.hitches.shift();
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const f = this.feed[i]!;
      f.life -= dt;
      if (f.life <= 0) {
        f.el.remove();
        this.feed.splice(i, 1);
      } else if (f.life < 0.5) f.el.style.opacity = '0';
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    const t = onlineStatusText(session, this.label);
    if (t !== this.text) this.el.textContent = this.text = t;
    this.updateNet(session, localMs);
    const m = session.match;
    const me = session.id;
    const s =
      m && me && session.status.state === 'online'
        ? matchLine(m, me, (id) => session.nameOf(id), session.phaseSecondsLeft(localMs))
        : '';
    if (s !== this.scoreText) {
      this.scoreText = s;
      this.score.textContent = s;
      this.score.style.display = s ? '' : 'none';
    }
  }

  private updateNet(session: OnlineSession, localMs: number): void {
    const online = session.status.state === 'online' && !this.label;
    const hitch = this.hitches.reduce((m, h) => Math.max(m, h.ms), 0);
    const n = online ? netIndicator(session.netStats(localMs), hitch) : null;
    const key = n ? `${n.ping}|${n.level}|${n.warning ?? ''}` : '';
    if (key === this.netText) return;
    this.netText = key;
    this.net.style.display = n ? '' : 'none';
    if (!n) return;
    this.netPing.textContent = `PING ${n.ping}`;
    this.netPing.style.color = NET_COLOURS[n.level];
    this.netWarn.textContent = n.warning ? `▲ ${n.warning}` : '';
    this.netWarn.style.color = NET_COLOURS[n.warning === 'NETWORK STALL' ? 'poor' : 'fair'];
    this.netWarn.style.display = n.warning ? '' : 'none';
  }
}
