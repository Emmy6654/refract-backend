import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import { OracleReading } from './oracle-reading';

@WebSocketGateway({ path: '/oracle' })
export class OracleGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(OracleGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: WebSocket): void {
    this.logger.log('Oracle WebSocket client connected');
    if (typeof client.on === 'function') {
      client.on('error', (err) => {
        this.logger.warn(`Oracle WebSocket client error: ${err.message}`);
      });
    }
    client.send(JSON.stringify({ type: 'connected', message: 'Refract oracle feed' }));
  }

  /**
   * Push a reading to every open client. In a split deployment the readings
   * come from the worker via the ReadingBus (see OracleFeedRelay); this
   * process never polls upstreams itself.
   */
  broadcastAlert(alert: OracleReading): void {
    if (!this.server?.clients) {
      return;
    }
    const payload = JSON.stringify({ ...alert, timestamp: Date.now() });
    let sent = 0;
    for (const client of this.server.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // send() can throw for a socket that is mid-close; one bad client must
      // not stop the broadcast to everyone else.
      try {
        client.send(payload);
        sent++;
      } catch (err) {
        this.logger.warn(
          `Failed to send oracle alert to a client: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.debug(`Broadcast ${alert.coverageType} alert to ${sent} client(s)`);
  }

  handleDisconnect(_client: WebSocket): void {
    this.logger.log('Oracle WebSocket client disconnected');
  }

  /**
   * Graceful shutdown: send a proper close frame to every connected client
   * before the shared HTTP server stops accepting connections. Dropping the
   * socket without a close frame would leave clients unable to distinguish a
   * clean shutdown from a network failure.
   */
  onModuleDestroy(): void {
    if (!this.server) {
      return;
    }

    const clients = this.server.clients;
    if (!clients || clients.size === 0) {
      return;
    }

    this.logger.log(
      `Closing ${clients.size} Oracle WebSocket client(s) during shutdown`,
    );

    for (const client of clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch (err) {
        this.logger.warn(
          `Failed to close Oracle WebSocket client: ${(err as Error).message}`,
        );
      }
    }
  }
}
