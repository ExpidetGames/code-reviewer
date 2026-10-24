// SPDX-License-Identifier: LicenseRef-Proprietary

// The fake Stripe API as a process of its own, for a journey that runs the app against it (`STRIPE_API_BASE_URL` of the app
// is its address): loopback only (`STRIPE_FAKE_HOST`, if set, must be a loopback address); the port is `STRIPE_FAKE_PORT`; the key it accepts is `STRIPE_FAKE_API_KEY` (a dummy
// test key by default). A journey drives it over HTTP under `/__fake/`: `GET health` and `GET events`, and
// `POST pay`, `refund`, `dispute`, `dispute/close`, `flush` and `reset` (see server.ts).
import { isLoopbackHostname } from "./loopback.ts";
import { startStripeFake } from "./server.ts";

const port = Number(process.env.STRIPE_FAKE_PORT);
if (!Number.isInteger(port) || port < 1)
  throw new Error("STRIPE_FAKE_PORT must be a port number.");
// `STRIPE_FAKE_HOST` exists only so that a wrong value is refused loudly: the fake never listens beyond the loopback.
const host = process.env.STRIPE_FAKE_HOST ?? "127.0.0.1";
if (!isLoopbackHostname(host))
  throw new Error(
    `STRIPE_FAKE_HOST must be a loopback address, not ${host}: the fake Stripe API never listens on a network.`,
  );
const apiKey = process.env.STRIPE_FAKE_API_KEY;
const fake = await startStripeFake({
  port,
  host,
  ...(apiKey === undefined ? {} : { apiKey }),
});
console.info(`fake Stripe listening at ${fake.baseUrl}`);
const stop = () => void fake.close().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
