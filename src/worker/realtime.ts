import { DurableObject } from "cloudflare:workers";

/**
 * One instance per workspace. Browsers hold a hibernatable WebSocket; the Worker POSTs
 * small change events ({type, task_id}) which are fanned out so clients refetch.
 */
export class Realtime extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const msg = await request.text();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(msg);
        } catch {
          // socket already gone
        }
      }
      return new Response("ok");
    }
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "closing");
    } catch {
      // ignore
    }
  }
}
