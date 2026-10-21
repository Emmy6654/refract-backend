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
    client.send(JSON.stringify({
      type: 'connected',
      message: 'Refract oracle feed connected',
      timestamp: new Date().toISOString(),
    }));
    client.on('error', (err) => {
      this.logger.warn(`Oracle WebSocket client error: ${err.message}`);
    });
  }

  handleDisconnect(_client: WebSocket): void {
    this.logger.log('Oracle WebSocket client disconnected');
  }

  broadcastAlert(reading: OracleReading): void {
    if (!this.server?.clients) {
      return;
    }
    const message = JSON.stringify({
      type: 'oracle_alert',
      data: reading,
      timestamp: new Date().toISOString(),
    });
    for (const client of this.server.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }
      try {
        client.send(message);
      } catch (error) {
        this.logger.warn(
          `Failed to send oracle alert: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
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
