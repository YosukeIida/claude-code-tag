// Throwaway repro tool for issue #1 (EU1: Spoke-side liveness detection).
//
// Minimal stand-in for the Hub's WebSocket endpoint, used only to give the
// Spoke something to open+register against in this sandbox, which has no
// access to the real deployed Hub's Slack credentials. It uses the same
// unmodified `ws` library the production Hub uses (WebSocketServer with the
// library default `autoPong: true`), which is the specific property under
// test — the issue measured that the real Hub answers ping with pong without
// any custom code, and this server exercises the same library behavior.
//
// Not a general-purpose Hub replacement: it only understands enough of the
// WsRpc wire format (src/ws/rpc.ts) to answer `register` so the Spoke's
// connectOnce() proceeds past the handshake.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8788);
const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer, path: "/spoke" });

wss.on("connection", (ws) => {
  console.log("[test-hub] spoke connected");
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.kind === "call" && msg.type === "register") {
      ws.send(JSON.stringify({ kind: "result", id: msg.id, ok: true, result: { ok: true } }));
      console.log("[test-hub] registered spoke");
    }
  });
  ws.on("ping", () => console.log("[test-hub] ping received (ws library auto-replies pong)"));
  ws.on("close", (code) => console.log(`[test-hub] spoke disconnected (code ${code})`));
});

httpServer.listen(PORT, () => console.log(`[test-hub] listening on :${PORT}`));
