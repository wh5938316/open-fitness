import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';

interface SocketAttachment {
  expiresAt: number;
}

/**
 * Data-free poke channel. Clients pull documents from the authenticated change
 * feed after a `changed` frame. `ping` is answered with `pong` by the runtime
 * without waking this object.
 */
export class FitnessEventsDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    const expiresAt = Number(new URL(request.url).searchParams.get('expiresAt'));
    if (!Number.isFinite(expiresAt)) return new Response('Missing socket expiry.', { status: 400 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ expiresAt } satisfies SocketAttachment);
    if (expiresAt <= Date.now()) server.close(4001, 'expired');
    else server.send(JSON.stringify({ v: 1, type: 'ready' }));
    await this.scheduleExpiry();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    if (this.attachment(ws).expiresAt <= Date.now()) ws.close(4001, 'expired');
  }

  override async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // Leave the close code that notify() or expiry already sent.
  }

  override async alarm(): Promise<void> {
    this.closeExpired();
    await this.scheduleExpiry();
  }

  async notify(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      if (this.attachment(ws).expiresAt <= now) {
        ws.close(4001, 'expired');
        continue;
      }
      ws.send(JSON.stringify({ v: 1, type: 'changed' }));
    }
  }

  private attachment(ws: WebSocket): SocketAttachment {
    const value = ws.deserializeAttachment() as SocketAttachment | null;
    return value && typeof value.expiresAt === 'number' ? value : { expiresAt: 0 };
  }

  private closeExpired(now = Date.now()): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.attachment(ws).expiresAt <= now) ws.close(4001, 'expired');
    }
  }

  private async scheduleExpiry(): Promise<void> {
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const ws of this.ctx.getWebSockets()) {
      const expiresAt = this.attachment(ws).expiresAt;
      if (expiresAt > now) next = Math.min(next, expiresAt);
    }
    if (!Number.isFinite(next)) return;
    await this.ctx.storage.setAlarm(next);
  }
}
