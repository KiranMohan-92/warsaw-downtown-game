/**
 * The truck HUD: in a seat, a visor panel with the seat and the truck's armour (segmented, red
 * and pulsing when it burns); near a truck on foot, the prompt to get in (the key and the seat
 * you'd get). DOM writes only on change.
 */
import type { SeatId } from '@wd/shared';

export const SEAT_LABEL: Readonly<Record<SeatId, string>> = {
  driver: 'DRIVER',
  front: 'FRONT GUNNER',
  rearL: 'BED · LEFT',
  rearR: 'BED · RIGHT',
};

export interface VehicleHudState {
  /** In a seat: which, and the truck's health share (0–1). */
  seat: SeatId | null;
  health: number;
  /** The front passenger aiming out of the window arc (the round would hit the cab). */
  outOfArc?: boolean;
  /** On foot near a truck: the prompt (null: nothing). */
  prompt: string | null;
}

export class VehicleHud {
  private readonly panel: HTMLDivElement;
  private readonly seatEl: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly prompt: HTMLDivElement;
  private key = '';

  constructor(root: HTMLElement) {
    const el = (cls: string, host: HTMLElement): HTMLDivElement => {
      const d = document.createElement('div');
      d.className = cls;
      host.append(d);
      return d;
    };
    this.panel = el('veh-panel', root);
    this.seatEl = el('veh-seat', this.panel);
    this.bar = el('veh-bar', this.panel);
    this.fill = el('veh-fill', this.bar);
    this.hint = el('veh-hint', this.panel);
    this.prompt = el('veh-prompt', root);
    this.panel.dataset.testid = 'vehicle-hud';
  }

  update(s: VehicleHudState, keys: { interact: string; switchSeat: string }): void {
    const hp = Math.round(Math.max(0, Math.min(1, s.health)) * 40);
    const key = `${s.seat ?? '-'}|${hp}|${s.outOfArc ? 1 : 0}|${s.prompt ?? ''}|${keys.interact}${keys.switchSeat}`;
    if (key === this.key) return;
    this.key = key;
    this.panel.classList.toggle('on', s.seat !== null);
    if (s.seat) {
      this.seatEl.textContent = SEAT_LABEL[s.seat];
      this.fill.style.transform = `scaleX(${hp / 40})`;
      this.bar.classList.toggle('low', hp <= 10);
      this.hint.textContent = s.outOfArc
        ? 'OUT OF THE WINDOW ARC'
        : `${keys.interact} GET OUT · ${keys.switchSeat} SWITCH SEAT`;
      this.hint.classList.toggle('warn', s.outOfArc === true);
    }
    this.prompt.classList.toggle('on', s.prompt !== null);
    if (s.prompt) this.prompt.textContent = s.prompt;
  }
}
