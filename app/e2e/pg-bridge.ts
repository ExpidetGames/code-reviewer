// SPDX-License-Identifier: LicenseRef-Proprietary

// Not a journey: lets the privileged Dynamic lane reach the Postgres server of the job. The lane runs in a network
// namespace of its own whose only network is loopback (and a guard that counts every attempt to leave it), so the
// server on the host is out of reach there. A Unix socket is a file, and files cross network namespaces: this program
// runs OUTSIDE the namespace (runner/scripts/run_dynamic_e2e.sh) and forwards a socket in a directory the lane can
// see to the server's TCP port; inside, `E2E_DATABASE_URL` names the directory (`?host=<directory>`, the way libpq and
// node-postgres address a socket). It forwards bytes and nothing else, and listens on no network address.
//
//   node e2e/pg-bridge.ts <directory> <postgres url of the server>
//
// Prints the URL to use inside the lane on its one line of output once it listens. Node runs it as it is (type
// stripping): relative imports with the extension and no TypeScript-only runtime syntax.
import { chmodSync, mkdirSync } from "node:fs";
import net from "node:net";

const [directory, serverUrl] = process.argv.slice(2);
if (!directory || !serverUrl)
  throw new Error("Usage: pg-bridge.ts <directory> <postgres url>");

const server = new URL(serverUrl);
if (server.hostname !== "127.0.0.1" && server.hostname !== "localhost")
  throw new Error("The bridge forwards to a server on this machine only.");
const port = Number(server.port) || 5432;

mkdirSync(directory, { recursive: true, mode: 0o755 });
// The name libpq looks for: <directory>/.s.PGSQL.<port of the URL, 5432 unless it names one>.
const socketPath = `${directory}/.s.PGSQL.5432`;

const listener = net.createServer((client) => {
  const upstream = net.connect({ host: "127.0.0.1", port });
  client.pipe(upstream);
  upstream.pipe(client);
  const end = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", end);
  upstream.on("error", end);
  client.on("close", end);
  upstream.on("close", end);
});

listener.listen(socketPath, () => {
  // The lane's root and the job's user must both be able to connect.
  chmodSync(socketPath, 0o777);
  // The directory as the host of the URL, percent-encoded: how node-postgres reads a socket.
  const login = server.username
    ? `${server.username}${server.password ? `:${server.password}` : ""}@`
    : "";
  console.log(
    `${server.protocol}//${login}${encodeURIComponent(directory)}${server.pathname}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    listener.close(() => process.exit(0));
  });
