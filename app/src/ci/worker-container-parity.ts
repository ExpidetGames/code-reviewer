// SPDX-License-Identifier: Apache-2.0

// Translates a compose service into the shape of the hardened container spec
// (contracts/worker-container.v1.json) so that the two can be compared (#325). Anything in the
// service that could change how the container is isolated and that the spec has no key for ends up
// in `unexpected`, so a flag added to a compose file shows as a difference instead of being ignored.
//
// Node runs the test that uses this file with type stripping: relative imports with the .ts
// extension and no TypeScript-only runtime syntax.

export type ComposeService = Record<string, unknown> & {
  environment?: Record<string, unknown>;
};

// What a compose service may carry that is not part of the container's isolation: where the image
// comes from, when it restarts, what it waits for and which values it gets. The environment names
// are compared separately (the test), a startup order or a restart policy does not isolate anything.
const NOT_HARDENING = new Set([
  "image",
  "build",
  "restart",
  "depends_on",
  "environment",
]);

// The compose keys the translation reads.
const TRANSLATED = new Set([
  "user",
  "cap_drop",
  "cap_add",
  "security_opt",
  "read_only",
  "tmpfs",
  "mem_limit",
  "mem_reservation",
  "memswap_limit",
  "pids_limit",
  "stop_grace_period",
]);

// Capabilities that exist for the startup of the container only (the spec marks them too).
const STARTUP_ONLY = new Set(["NET_ADMIN", "SETPCAP"]);

/** `${NAME:-fallback}` is the self-hosted default `fallback`; a plain value is itself. */
function defaultOf(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = /^\$\{[A-Za-z0-9_]+:-([^}]*)\}$/.exec(value);
  return match === null ? value : match[1];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function seconds(value: unknown): unknown {
  const match = /^([0-9]+)s$/.exec(String(value));
  return match === null ? value : Number(match[1]);
}

function tmpfsOf(entry: string): Record<string, unknown> {
  const [path = "", rest = ""] = [
    entry.slice(0, entry.indexOf(":")),
    entry.slice(entry.indexOf(":") + 1),
  ];
  const options: string[] = [];
  const mount: Record<string, unknown> = { path, options };
  for (const part of rest.split(",")) {
    const [name = "", value] = part.split("=");
    if (value === undefined) options.push(name);
    else if (name === "uid" || name === "gid") mount[name] = Number(value);
    else if (name === "size" || name === "mode") mount[name] = value;
    // A value option the spec has no key for stays visible as an option, so it shows as a difference.
    else options.push(`${name}=${value}`);
  }
  return {
    path: mount.path,
    options: mount.options,
    size: mount.size,
    mode: mount.mode,
    ...(mount.uid === undefined ? {} : { uid: mount.uid }),
    ...(mount.gid === undefined ? {} : { gid: mount.gid }),
  };
}

/** The compose service as a (partial) hardened container spec, plus the keys it has no equivalent for. */
export function specFromComposeService(
  service: ComposeService,
): Record<string, unknown> {
  const unexpected = Object.keys(service)
    .filter((key) => !TRANSLATED.has(key) && !NOT_HARDENING.has(key))
    .sort();

  return {
    user: service.user,
    capDrop: strings(service.cap_drop),
    capAdd: strings(service.cap_add).map((entry) => {
      // "SETUID # comment" is already split by the YAML parser; keep the name only.
      const name = entry.split(/\s+/)[0] ?? entry;
      return { name, startupOnly: STARTUP_ONLY.has(name) };
    }),
    securityOpt: strings(service.security_opt),
    readOnly: service.read_only,
    tmpfs: strings(service.tmpfs).map(tmpfsOf),
    memory: {
      limit: defaultOf(service.mem_limit),
      reservation: defaultOf(service.mem_reservation),
      swap: defaultOf(service.memswap_limit),
    },
    pids: { limit: Number(defaultOf(service.pids_limit)) },
    stopTimeoutSeconds: seconds(service.stop_grace_period),
    unexpected,
  };
}

/** JSON with the keys of every object in sorted order, so that equal values compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );
}

/** The keys of the translation that the spec states and that differ; `unexpected` must be empty. */
export function differences(
  spec: Record<string, unknown>,
  translated: Record<string, unknown>,
): string[] {
  const found: string[] = [];
  const keys = [
    "user",
    "capDrop",
    "capAdd",
    "securityOpt",
    "readOnly",
    "tmpfs",
    "memory",
    "pids",
    "stopTimeoutSeconds",
  ];
  for (const key of keys) {
    if (canonical(spec[key]) !== canonical(translated[key])) found.push(key);
  }
  const unexpected = translated.unexpected;
  if (Array.isArray(unexpected) && unexpected.length > 0)
    found.push(`unexpected: ${unexpected.join(", ")}`);
  return found;
}
