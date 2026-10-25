// SPDX-License-Identifier: LicenseRef-Proprietary

// Whether the app runs as a long-lived server (Docker, Coolify: the default, and the only mode before
// #319) or as serverless functions (every instance starts cold, many run at once, none lives long).
// `APP_RUNTIME=server|serverless` decides; without it the platform's own marker (`VERCEL=1`) selects
// serverless, and nothing else does. A pure function of the environment passed in, so the database
// configuration and the start can be tested for both modes without touching `process.env`.
export const RUNTIME_MODES = ["server", "serverless"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const RUNTIME_ERROR_CODES = ["APP_RUNTIME_INVALID"] as const;
export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export class RuntimeConfigError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeConfigError";
    this.code = code;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** The configured mode. An unknown `APP_RUNTIME` is a mistake that is named, never guessed at. */
export function resolveRuntimeMode(env: Env): RuntimeMode {
  const configured = env.APP_RUNTIME?.trim().toLowerCase();
  if (configured) {
    const mode = RUNTIME_MODES.find((candidate) => candidate === configured);
    if (mode) return mode;
    throw new RuntimeConfigError(
      "APP_RUNTIME_INVALID",
      `APP_RUNTIME must be "server" or "serverless". Leave it empty for the default (server, or serverless on the hosting platform).`,
    );
  }
  return env.VERCEL === "1" ? "serverless" : "server";
}

export function isServerless(env: Env = process.env): boolean {
  return resolveRuntimeMode(env) === "serverless";
}
