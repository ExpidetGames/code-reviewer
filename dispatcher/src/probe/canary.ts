// SPDX-License-Identifier: Apache-2.0

// The deploy canary (#331): a step of the release pipeline that calls `POST /probe` of a freshly deployed Dispatcher
// and fails the release when the Dynamic-Worker's canary does not pass. It sends the dispatcher credential to
// that one URL and nowhere else (no redirect is followed, http only to this machine), prints stable codes and the
// stable reasons of the contract and never the credential or any text the deployment sent.
//
//   exit 0  the deployment advertises every required engine from a probe that ran just now
//   exit 1  it does not, it could not be reached, or it answered something that is not a report: block the release
//   exit 2  wrong use (nothing was sent)
//
// The credential is `RUNNER_TOKEN` in the environment, never an argument (an argument shows up in process lists
// and logs).
import { z } from "zod";
import type { Clock, Engine } from "../core/types.ts";
import { probeFailureCode } from "./failure-codes.ts";
import { PROBE_REASONS } from "./verdict.ts";

const HEALTH_INTERVAL_SECONDS = 5;
const DEFAULT_PROBE_TIMEOUT_SECONDS = 300;
const HOST_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ENGINES: readonly Engine[] = ["pr-agent", "opencode"];

export type CanaryOptions = {
  /** The base URL of the Dispatcher deployment, for example `https://dispatcher.example`. */
  url: string;
  /** The dispatcher credential. A secret. */
  token: string;
  /**
   * The host names the credential may be sent to (exact, case does not matter, the port does not). When there is a
   * list, a URL whose host is not on it is refused before any request, this machine included; an empty list refuses
   * everything. Without one, any https host (or this machine) is allowed: for a person at a terminal, not for CI.
   */
  allowedHosts?: readonly string[];
  /** Only check the URL against the list: no request, no credential needed. For a step that holds no secret. */
  checkOnly?: boolean;
  /** The engines the release needs; both by default. */
  requiredEngines?: readonly Engine[];
  /** How long to wait for the deployment to answer `GET /health` before the credential is sent. 0: one try. */
  healthWaitSeconds?: number;
  probeTimeoutSeconds?: number;
  /** Platform deployment protection: sent as `x-vercel-protection-bypass`. A secret. */
  bypassSecret?: string;
  fetch?: typeof fetch;
  clock: Clock;
  write: (line: string) => void;
};

const ReportSchema = z.object({
  version: z.literal(1),
  status: z.enum(["passed", "denied", "failed"]),
  ok: z.boolean(),
  engines: z.array(z.string()).max(16),
  reasons: z.array(z.string()).max(64),
  failure: z.string().max(100).optional(),
});

export class CanaryUsageError extends Error {
  constructor(what: string) {
    super(what);
    this.name = "CanaryUsageError";
  }
}

const USAGE =
  "usage: probe:canary --url <https://dispatcher> [--allowed-hosts <host,host>] [--check-only] [--engines pr-agent,opencode] [--wait-seconds <n>] [--timeout-seconds <n>]; the credential is RUNNER_TOKEN in the environment, the allowed hosts may also be CANARY_ALLOWED_HOSTS";

function seconds(value: string | undefined, name: string, max: number): number {
  const number = Number(value);
  if (
    value === undefined ||
    !Number.isInteger(number) ||
    number < 0 ||
    number > max
  )
    throw new CanaryUsageError(
      `${name} must be a whole number from 0 to ${max}`,
    );
  return number;
}

/** The options of a command line and its environment. Throws `CanaryUsageError` (never with a value of an argument). */
export function parseCanaryArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Omit<CanaryOptions, "clock" | "write" | "fetch"> {
  const values = new Map<string, string>();
  let checkOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--check-only") {
      checkOnly = true;
      continue;
    }
    const value = argv[index + 1];
    index += 1;
    if (
      name === undefined ||
      value === undefined ||
      ![
        "--url",
        "--engines",
        "--wait-seconds",
        "--timeout-seconds",
        "--allowed-hosts",
      ].includes(name)
    )
      throw new CanaryUsageError(USAGE);
    values.set(name, value);
  }
  const url = values.get("--url");
  if (url === undefined)
    throw new CanaryUsageError(`--url is required. ${USAGE}`);
  const token = env.RUNNER_TOKEN ?? "";
  if (token === "" && !checkOnly)
    throw new CanaryUsageError(
      "RUNNER_TOKEN is required (the dispatcher credential)",
    );
  const listed = values.get("--allowed-hosts") ?? env.CANARY_ALLOWED_HOSTS;
  const allowedHosts =
    listed === undefined
      ? undefined
      : listed
          .split(",")
          .map((host) => host.trim().toLowerCase())
          .filter((host) => host !== "");
  if (allowedHosts?.some((host) => !HOST_NAME.test(host)))
    throw new CanaryUsageError(
      "--allowed-hosts takes host names, separated by commas",
    );

  const named = values.get("--engines");
  const requiredEngines = (
    named === undefined ? [...ENGINES] : named.split(",")
  ).map((engine) => {
    const known = ENGINES.find((candidate) => candidate === engine);
    if (known === undefined)
      throw new CanaryUsageError("--engines takes pr-agent and opencode");
    return known;
  });
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return {
    url,
    token,
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    ...(checkOnly ? { checkOnly } : {}),
    requiredEngines,
    healthWaitSeconds: values.has("--wait-seconds")
      ? seconds(values.get("--wait-seconds"), "--wait-seconds", 1800)
      : 120,
    probeTimeoutSeconds: values.has("--timeout-seconds")
      ? seconds(values.get("--timeout-seconds"), "--timeout-seconds", 1800)
      : DEFAULT_PROBE_TIMEOUT_SECONDS,
    ...(bypass === undefined || bypass === "" ? {} : { bypassSecret: bypass }),
  };
}

/** The base of the Dispatcher, or undefined when the credential must not be sent there. */
function baseOf(input: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  if (!secure) return undefined;
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  return url;
}

/** Runs the canary and returns the exit status. */
export async function runCanary(options: CanaryOptions): Promise<0 | 1 | 2> {
  const { write } = options;
  const base = baseOf(options.url);
  if (base === undefined) {
    write(
      "canary: canary_url_invalid (https, or http to this machine; no path, query or credentials)",
    );
    return 2;
  }
  if (
    options.allowedHosts !== undefined &&
    !options.allowedHosts.includes(base.hostname.toLowerCase())
  ) {
    write(
      "canary: canary_host_not_allowed (the host is not on the list of hosts the credential may be sent to)",
    );
    return 2;
  }
  if (options.checkOnly === true) {
    write("canary: the URL is allowed");
    return 0;
  }
  const request = options.fetch ?? fetch;
  const required = options.requiredEngines ?? ENGINES;
  const bypass: Record<string, string> =
    options.bypassSecret === undefined
      ? {}
      : { "x-vercel-protection-bypass": options.bypassSecret };
  const at = (path: string) => new URL(path, base).toString();

  // 1. The deployment answers. The credential is not sent until it does, and never to /health.
  const tries =
    Math.ceil((options.healthWaitSeconds ?? 0) / HEALTH_INTERVAL_SECONDS) + 1;
  let ready = false;
  for (let attempt = 1; attempt <= tries && !ready; attempt += 1) {
    try {
      const answer = await request(at("/health"), {
        headers: bypass,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      ready = answer.status === 200;
    } catch {
      ready = false;
    }
    if (!ready && attempt < tries)
      await options.clock.sleep(HEALTH_INTERVAL_SECONDS * 1000);
  }
  if (!ready) {
    write("canary: deployment_not_ready, nothing was sent but GET /health");
    return 1;
  }

  // 2. The probe, forced.
  let answer: Response;
  try {
    answer = await request(at("/probe"), {
      method: "POST",
      headers: { ...bypass, authorization: `Bearer ${options.token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(
        (options.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS) * 1000,
      ),
    });
  } catch {
    write("canary: probe_unreachable, the release is blocked");
    return 1;
  }
  if (answer.status !== 200 && answer.status !== 503) {
    write(`canary: refused (status ${answer.status}), the release is blocked`);
    return 1;
  }
  let report: z.infer<typeof ReportSchema>;
  try {
    report = ReportSchema.parse(await answer.json());
  } catch {
    write(
      `canary: canary_unreadable (status ${answer.status}), the release is blocked`,
    );
    return 1;
  }

  // Only what the contract lists is printed: a value shaped like a secret in the answer goes nowhere.
  const engines = report.engines.filter((engine): engine is Engine =>
    ENGINES.some((known) => known === engine),
  );
  const reasons = report.reasons.filter((reason) =>
    PROBE_REASONS.some((known) => known === reason),
  );
  const details = [
    `engines=${engines.join(",") === "" ? "none" : engines.join(",")}`,
    ...(reasons.length === 0 ? [] : [`reasons=${reasons.join(",")}`]),
    ...(report.failure === undefined
      ? []
      : [`failure=${probeFailureCode(report.failure)}`]),
  ].join(" ");
  const missing = required.filter((engine) => !engines.includes(engine));
  if (answer.status === 200 && report.ok && missing.length === 0) {
    write(`canary: ${report.status} ${details}`);
    return 0;
  }
  write(
    `canary: ${report.status} ${details}${missing.length === 0 ? "" : ` missing=${missing.join(",")}`}, the release is blocked`,
  );
  return 1;
}
