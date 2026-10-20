// SPDX-License-Identifier: Apache-2.0

// The fake models.dev as a process of its own (#554), for the Playwright run: the app under test fetches the catalog from
// it (`MODELS_DEV_URL`) and a journey scripts it over HTTP (see `server.ts`). Loopback only; the port is
// `MODELS_DEV_FAKE_PORT`; it answers 503 until a body is scripted.
import { startModelsDevFake } from "./server.ts";

const port = Number(process.env.MODELS_DEV_FAKE_PORT);
if (!Number.isInteger(port) || port < 1)
  throw new Error("MODELS_DEV_FAKE_PORT must be a port number.");
const fake = await startModelsDevFake({ port });
// Until a journey scripts a body, the catalog is not there: the app under test fetches at its start (a production server
// does) and must find nothing, so that the first fetch is the journey's own.
fake.respondWithStatus(503);
console.info(`fake models.dev listening at ${fake.url}`);
const stop = () => void fake.stop().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
