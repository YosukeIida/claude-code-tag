// Throwaway repro tool for issue #1 (EU1: Spoke-side liveness detection).
//
// TCP proxy that forwards bytes between the Spoke and the test Hub and,
// until told to go silent, behaves like a transparent pipe. On a signal
// (a touch of SIGNAL_FILE) it pauses every existing pipe in both directions
// *without* destroying or ending either socket — bytes stop flowing but no
// FIN/RST is ever sent. That is exactly the half-open condition described in
// issue #1: a path that silently stops delivering packets while both TCP
// endpoints believe the connection is still open. New connections made after
// the signal (i.e. the Spoke's reconnect) are unaffected and proxy normally.
import net from "node:net";
import fs from "node:fs";

const LISTEN_PORT = Number(process.env.PROXY_PORT ?? 8789);
const TARGET_PORT = Number(process.env.TARGET_PORT ?? 8788);
const TARGET_HOST = process.env.TARGET_HOST ?? "127.0.0.1";
const SIGNAL_FILE = process.env.SIGNAL_FILE ?? "/tmp/silent-proxy-signal";

if (!fs.existsSync(SIGNAL_FILE)) fs.writeFileSync(SIGNAL_FILE, "");

const pairs = [];

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST);
  console.log("[proxy] new connection, forwarding");
  client.pipe(upstream);
  upstream.pipe(client);
  const pair = { client, upstream };
  pairs.push(pair);
  client.on("close", () => console.log("[proxy] client socket closed"));
  upstream.on("close", () => console.log("[proxy] upstream socket closed"));
});

server.listen(LISTEN_PORT, () =>
  console.log(`[proxy] listening :${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`),
);

let lastMtimeMs = fs.statSync(SIGNAL_FILE).mtimeMs;
fs.watchFile(SIGNAL_FILE, { interval: 200 }, (curr) => {
  if (curr.mtimeMs === lastMtimeMs) return;
  lastMtimeMs = curr.mtimeMs;
  console.log(`[proxy] signal received — going silent on ${pairs.length} pair(s), no FIN/RST sent`);
  for (const { client, upstream } of pairs) {
    client.unpipe(upstream);
    upstream.unpipe(client);
    client.pause();
    upstream.pause();
  }
});
