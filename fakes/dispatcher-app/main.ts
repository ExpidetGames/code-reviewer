// SPDX-License-Identifier: LicenseRef-Proprietary

// Starts the fake App for the Dispatcher and the Worker as its own process, for the suites that cannot
// call it in-process (the Python Worker tests, the journeys). Configuration comes from the environment;
// the values are dummies shared with the suite. The control API is described in server.ts.
//
//   DISPATCHER_APP_FAKE_PORT   default 4030
//   DISPATCHER_APP_FAKE_HOST   default 127.0.0.1
//   DISPATCHER_APP_FAKE_TOKEN  the dispatcher credential it accepts, default fake-dispatcher-token
import { startDispatcherAppFake } from "./server.ts";

const port = Number(process.env.DISPATCHER_APP_FAKE_PORT ?? "4030");
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("DISPATCHER_APP_FAKE_PORT must be a port number.");
  process.exit(1);
}

const fake = await startDispatcherAppFake({
  host: process.env.DISPATCHER_APP_FAKE_HOST || "127.0.0.1",
  port,
  dispatcherToken: process.env.DISPATCHER_APP_FAKE_TOKEN || undefined,
});
console.info(`Fake App listening on ${fake.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void fake.close().then(() => process.exit(0));
  });
}
