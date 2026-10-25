import { QUICK_CHAT, type QuickChatId } from '@wd/shared';

export const WHEEL = {
  /** Mouse travel (counts) before a segment lights up. */
  deadzone: 40,
  /** The pointer stops this far from the centre (counts): reversing never takes long. */
  radius: 160,
  /** Radius of the labels on screen (px). */
  labelRadius: 150,
} as const;

/**
 * The segment the pointer offset points at: `count` segments clockwise from the top (screen
 * coordinates, y down), -1 inside the dead zone.
 */
export function wheelPick(x: number, y: number, count: number, deadzone: number): number {
  if (Math.hypot(x, y) < deadzone || count <= 0) return -1;
  // 0 at the top, growing clockwise.
  const angle = Math.atan2(x, -y);
  const turn = (angle / (2 * Math.PI) + 1) % 1;
  return Math.round(turn * count) % count;
}

/** The preset a number key picks (1–9, then 0 for the tenth), or -1. */
export function wheelKey(code: string): number {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (!m) return -1;
  const n = Number(m[1]);
  const i = n === 0 ? 9 : n - 1;
  return i < QUICK_CHAT.length ? i : -1;
}

/**
 * The hold-to-open quick-chat wheel: the presets round the crosshair, numbered 1–9, 0. While it
 * is open the mouse moves a pointer (the view doesn't turn) and lights the segment it points at;
 * release the key or click to say it, or press its number.
 */
export class QuickChatWheel {
  readonly root = document.createElement('div');
  private readonly items: HTMLDivElement[] = [];
  private readonly dot = document.createElement('div');
  private x = 0;
  private y = 0;
  private shownIndex = -2;
  private isOpen = false;

  constructor(parent: HTMLElement) {
    this.root.className = 'quick-wheel';
    this.root.dataset.testid = 'quick-wheel';
    const hub = document.createElement('div');
    hub.className = 'qw-hub';
    const title = document.createElement('div');
    title.className = 'qw-title';
    title.textContent = 'QUICK CHAT';
    const hint = document.createElement('div');
    hint.className = 'qw-hint';
    hint.textContent = 'release or click to send · 1–9, 0';
    hub.append(title, hint);
    this.dot.className = 'qw-dot';
    this.root.append(hub, this.dot);
    QUICK_CHAT.forEach((q, i) => {
      const el = document.createElement('div');
      el.className = 'qw-item';
      const a = (i / QUICK_CHAT.length) * 2 * Math.PI;
      el.style.left = `${Math.sin(a) * WHEEL.labelRadius}px`;
      el.style.top = `${-Math.cos(a) * WHEEL.labelRadius}px`;
      const key = document.createElement('kbd');
      key.textContent = String((i + 1) % 10);
      const text = document.createElement('span');
      text.textContent = q.text;
      el.append(key, text);
      this.root.append(el);
      this.items.push(el);
    });
    parent.append(this.root);
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** The lit segment (-1: none). */
  get selected(): number {
    return wheelPick(this.x, this.y, QUICK_CHAT.length, WHEEL.deadzone);
  }

  get selectedId(): QuickChatId | null {
    return QUICK_CHAT[this.selected]?.id ?? null;
  }

  show(on: boolean): void {
    if (on === this.isOpen) return;
    this.isOpen = on;
    this.x = 0;
    this.y = 0;
    this.root.classList.toggle('on', on);
    this.render();
  }

  /** Mouse travel while open (counts). */
  move(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    const r = Math.hypot(this.x, this.y);
    if (r > WHEEL.radius) {
      this.x *= WHEEL.radius / r;
      this.y *= WHEEL.radius / r;
    }
    this.render();
  }

  /** Point at a segment (probes and screenshots). */
  point(index: number): void {
    const a = (index / QUICK_CHAT.length) * 2 * Math.PI;
    this.x = Math.sin(a) * WHEEL.radius;
    this.y = -Math.cos(a) * WHEEL.radius;
    this.render();
  }

  private render(): void {
    const s = this.isOpen ? this.selected : -1;
    const k = WHEEL.labelRadius / WHEEL.radius;
    this.dot.style.transform = `translate(${this.x * k * 0.55}px, ${this.y * k * 0.55}px)`;
    if (s === this.shownIndex) return;
    this.shownIndex = s;
    this.items.forEach((el, i) => el.classList.toggle('lit', i === s));
  }
}
