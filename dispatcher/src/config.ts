// SPDX-License-Identifier: Apache-2.0

// What the operator configures, read from environment variables. A refusal names the variable and
// never the value: two of them are secrets.
//
// | Variable                                                    | Meaning                                              | Default |
// |-------------------------------------------------------------|------------------------------------------------------|---------|
// | RUNNER_API_URL                                              | Base URL of the App                                  | required |
// | RUNNER_TOKEN                                                | The dispatcher credential (the runner API token)     | required |
// | DISPATCHER_MAX_RUNNING                                      | The pool cap (1 to 1000)                             | required |
// | DISPATCHER_SIGNING_KEY_ID / DISPATCHER_SIGNING_SECRET       | The key the App signs the wake-up call with          | required |
// | DISPATCHER_SIGNING_KEY_ID_PREVIOUS / ..._SECRET_PREVIOUS    | The previous key, accepted while rotating            | none |
// | DISPATCHER_POOL_ID                                          | Sent as X-Runner-Id; the App counts the pool by it   | dispatcher |
// | DISPATCHER_ENGINES                                          | Engines to serve, `pr-agent,opencode`                | both |
// | DISPATCHER_JOB_TIMEOUT_SECONDS                              | How long a Worker may live (60 to 21600)             | 1200 |
// | DISPATCHER_WORKER_CONFIG                                    | JSON `{diff?, dynamic?}`: container memory, launcher options | none |
// | CRON_SECRET (Vercel entry)                                  | The secret of the platform's cron for the reaper route (#364), at least 32 characters, distinct from every other secret | none: the route refuses everyone |
// | DISPATCHER_SHUTDOWN_GRACE_SECONDS (Node entry)              | How long launches may finish after SIGTERM (0 to 600) | 60 |
import { z } from "zod";
import type {
  CoreSettings,
  Engine,
  ReviewKind,
  LaunchConfig,
} from "./core/types.ts";
import type { SigningKey } from "./triggers/signature.ts";

export const CONFIG_REASONS = [
  "required",
  "invalid",
  "too_short",
  "not_distinct",
] as const;
export type ConfigReason = (typeof CONFIG_REASONS)[number];

export class ConfigError extends Error {
  readonly variable: string;
  readonly reason: ConfigReason;

  constructor(variable: string, reason: ConfigReason) {
    super(`${variable} is ${reason.replace("_", " ")}`);
    this.name = "ConfigError";
    this.variable = variable;
    this.reason = reason;
  }
}

export type Settings = {
  core: CoreSettings;
  /** `CRON_SECRET`: what the reaper's cron route (#364) accepts. Absent: the route refuses every caller. */
  cronSecret: string | undefined;
  /** The current key first, then the previous one if there is one. */
  signingKeys: SigningKey[];
  shutdownGraceSeconds: number;
};

export type Environment = Readonly<Record<string, string | undefined>>;

const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const POOL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
const ENGINES: readonly Engine[] = ["pr-agent", "opencode"];
const MIN_SECRET_LENGTH = 32;
const CONTROL_OR_SPACE = /[\s\p{Cc}]/u;

export function read(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function required(env: Environment, name: string): string {
  const value = read(env, name);
  if (value === undefined) throw new ConfigError(name, "required");
  return value;
}

export function integer(
  env: Environment,
  name: string,
  range: { min: number; max: number; fallback?: number },
): number {
  const raw = read(env, name);
  if (raw === undefined) {
    if (range.fallback === undefined) throw new ConfigError(name, "required");
    return range.fallback;
  }
  const value = Number(raw);
  if (!/^\d{1,9}$/.test(raw) || value < range.min || value > range.max)
    throw new ConfigError(name, "invalid");
  return value;
}

function appUrl(env: Environment): string {
  const raw = required(env, "RUNNER_API_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("RUNNER_API_URL", "invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new ConfigError("RUNNER_API_URL", "invalid");
  return raw.replace(/\/+$/, "");
}

function token(env: Environment): string {
  const value = required(env, "RUNNER_TOKEN");
  if (CONTROL_OR_SPACE.test(value))
    throw new ConfigError("RUNNER_TOKEN", "invalid");
  return value;
}

function key(env: Environment, idName: string, secretName: string): SigningKey {
  const kid = required(env, idName);
  if (!KEY_ID.test(kid)) throw new ConfigError(idName, "invalid");
  const secret = required(env, secretName);
  if (secret.length < MIN_SECRET_LENGTH)
    throw new ConfigError(secretName, "too_short");
  if (CONTROL_OR_SPACE.test(secret))
    throw new ConfigError(secretName, "invalid");
  return { kid, secret };
}

function signingKeys(env: Environment, dispatcherToken: string): SigningKey[] {
  const keys = [
    key(env, "DISPATCHER_SIGNING_KEY_ID", "DISPATCHER_SIGNING_SECRET"),
  ];
  const previousId = read(env, "DISPATCHER_SIGNING_KEY_ID_PREVIOUS");
  const previousSecret = read(env, "DISPATCHER_SIGNING_SECRET_PREVIOUS");
  if (previousId !== undefined || previousSecret !== undefined)
    keys.push(
      key(
        env,
        "DISPATCHER_SIGNING_KEY_ID_PREVIOUS",
        "DISPATCHER_SIGNING_SECRET_PREVIOUS",
      ),
    );
  const names = [
    "DISPATCHER_SIGNING_SECRET",
    "DISPATCHER_SIGNING_SECRET_PREVIOUS",
  ];
  keys.forEach((signing, index) => {
    // The signing secret is distinct from every other secret.
    const duplicated =
      signing.secret === dispatcherToken ||
      keys.some(
        (other, otherIndex) =>
          otherIndex < index && other.secret === signing.secret,
      ) ||
      keys.some(
        (other, otherIndex) => otherIndex < index && other.kid === signing.kid,
      );
    if (duplicated)
      throw new ConfigError(names[index] ?? names[0] ?? "", "not_distinct");
  });
  return keys;
}

/** The cron secret: a secret of its own, so no other credential opens the reaper's route and it opens nothing else. */
function cronSecret(
  env: Environment,
  dispatcherToken: string,
  keys: readonly SigningKey[],
): string | undefined {
  const value = read(env, "CRON_SECRET");
  if (value === undefined) return undefined;
  if (value.length < MIN_SECRET_LENGTH)
    throw new ConfigError("CRON_SECRET", "too_short");
  if (CONTROL_OR_SPACE.test(value))
    throw new ConfigError("CRON_SECRET", "invalid");
  if (
    value === dispatcherToken ||
    keys.some((signing) => signing.secret === value)
  )
    throw new ConfigError("CRON_SECRET", "not_distinct");
  return value;
}

function engines(env: Environment): Engine[] {
  const raw = read(env, "DISPATCHER_ENGINES");
  if (raw === undefined) return [...ENGINES];
  const names = raw.split(",").map((name) => name.trim());
  const unique = [...new Set(names)];
  if (
    !unique.every((name): name is Engine =>
      (ENGINES as readonly string[]).includes(name),
    )
  )
    throw new ConfigError("DISPATCHER_ENGINES", "invalid");
  return unique;
}

const memorySize = z.string().regex(/^[0-9]+[mg]$/);
const kindConfig = z.strictObject({
  container: z
    .strictObject({
      memory: z
        .strictObject({
          limit: memorySize.optional(),
          reservation: memorySize.optional(),
          swap: memorySize.optional(),
        })
        .optional(),
    })
    .optional(),
  launcher: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});
const workerConfig = z.strictObject({
  diff: kindConfig.optional(),
  dynamic: kindConfig.optional(),
});

function workerConfigs(env: Environment): Record<ReviewKind, LaunchConfig> {
  const raw = read(env, "DISPATCHER_WORKER_CONFIG");
  if (raw === undefined) return { diff: {}, dynamic: {} };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError("DISPATCHER_WORKER_CONFIG", "invalid");
  }
  const parsed = workerConfig.safeParse(json);
  if (!parsed.success)
    throw new ConfigError("DISPATCHER_WORKER_CONFIG", "invalid");
  return { diff: parsed.data.diff ?? {}, dynamic: parsed.data.dynamic ?? {} };
}

function poolId(env: Environment): string {
  const value = read(env, "DISPATCHER_POOL_ID") ?? "dispatcher";
  if (!POOL_ID.test(value))
    throw new ConfigError("DISPATCHER_POOL_ID", "invalid");
  return value;
}

export function loadSettings(env: Environment): Settings {
  const dispatcherToken = token(env);
  const keys = signingKeys(env, dispatcherToken);
  return {
    core: {
      appUrl: appUrl(env),
      token: dispatcherToken,
      poolId: poolId(env),
      maxRunning: integer(env, "DISPATCHER_MAX_RUNNING", { min: 1, max: 1000 }),
      engines: engines(env),
      jobTimeoutSeconds: integer(env, "DISPATCHER_JOB_TIMEOUT_SECONDS", {
        min: 60,
        max: 21600,
        fallback: 1200,
      }),
      launchDeadlineSeconds: 300,
      workerConfig: workerConfigs(env),
    },
    cronSecret: cronSecret(env, dispatcherToken, keys),
    signingKeys: keys,
    shutdownGraceSeconds: integer(env, "DISPATCHER_SHUTDOWN_GRACE_SECONDS", {
      min: 0,
      max: 600,
      fallback: 60,
    }),
  };
}
