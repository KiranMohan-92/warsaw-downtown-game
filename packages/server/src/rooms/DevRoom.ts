import { Room, type Client } from '@colyseus/core';
import { PingMessage, type PongMessage } from '@wd/shared';

/** M0 wiring check: echoes pings so the client can show "server: connected" and an RTT. */
export class DevRoom extends Room {
  override maxClients = 6;
  // Slow devices can block the main thread for seconds on first load (shader compile); give
  // them time to open the socket after reserving a seat.
  override seatReservationTimeout = 30;

  override onCreate(): void {
    this.onMessage('ping', PingMessage, (client: Client, msg) => {
      const pong: PongMessage = { t: msg.t, serverTime: Date.now() };
      client.send('pong', pong);
    });
  }
}
