// SPDX-License-Identifier: Apache-2.0

// `pnpm snapshot:ops <decide|persist|cleanup>` (#403): the steps of the deployment pipeline that look after the
// golden snapshot around a deployment, in one command so that the logic is testable apart from the workflow.
//
//   decide    does the Worker image need a new snapshot? Writes the answer and the pair to use as step outputs.
//   persist   writes a pair to Infisical `prod` `/dispatcher` (after the promotion, or for a rollback).
//   verify    is a deployment a ready production deployment of the project? (before a rollback)
//   cleanup   removes the snapshots that are neither the current one, the previous one nor the live one; or
//             discards the snapshot of a run that did not reach production.
//
// Ids, tokens and the client secret come from the environment, never from arguments. Every line printed is a stable
// code. The snapshot and image ids go to the step outputs file only: they are not secrets, and GitHub drops an
// output that holds a masked value, so they are not masked.
//
// Exit status: 0 done, 1 failed (a code was printed), 2 wrong use (nothing was done).
import type { SnapshotService } from "./service.ts";
import { planCleanup } from "./cleanup.ts";
import { decide } from "./decide.ts";
import { persistPair } from "./infisical.ts";
import {
  isCommit,
  isSnapshotId,
  pairFrom,
  pairFromValues,
  parseDotenv,
  type SnapshotPair,
} from "./pair.ts";
import { BUILDER_PREFIX } from "./pipeline.ts";
import {
  livePair,
  pairOfDeployment,
  productionDeployment,
  type PairLookup,
  type VercelAuth,
} from "./vercel-api.ts";
import type { VercelCredentials } from "./vercel-service.ts";

export type OpsDeps = {
  env: Readonly<Record<string, string | undefined>>;
  stdout(text: string): void;
  stderr(line: string): void;
  readText(path: string): string;
  appendText(path: string, text: string): void;
  commitKnown(commit: string): Promise<boolean>;
  pathsChanged(
    from: string,
    to: string,
    paths: readonly string[],
  ): Promise<boolean>;
  createService(
    credentials: VercelCredentials,
  ): SnapshotService | Promise<SnapshotService>;
  fetch: typeof fetch;
};

class Usage extends Error {}

type Options = { values: Map<string, string>; flags: Set<string> };

function parseOptions(
  argv: readonly string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[],
): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index] ?? "";
    if (flagOptions.includes(name)) {
      flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (
      !valueOptions.includes(name) ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new Usage(valueOptions.includes(name) ? name : "unknown_option");
    values.set(name, value);
    index += 1;
  }
  return { values, flags };
}

function required(env: OpsDeps["env"], names: readonly string[]): void {
  for (const name of names) if (!env[name]) throw new Usage(name);
}

function vercelAuth(env: OpsDeps["env"]): VercelAuth {
  required(env, ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"]);
  return {
    token: env.VERCEL_TOKEN as string,
    teamId: env.VERCEL_TEAM_ID as string,
    projectId: env.VERCEL_PROJECT_ID as string,
  };
}

async function runDecide(
  argv: readonly string[],
  deps: OpsDeps,
): Promise<number> {
  const { values, flags } = parseOptions(
    argv,
    ["--sha", "--env-file", "--github-output"],
    ["--force"],
  );
  const sha = values.get("--sha");
  const envFile = values.get("--env-file");
  const output = values.get("--github-output");
  if (!isCommit(sha)) throw new Usage("--sha");
  if (!envFile) throw new Usage("--env-file");
  if (!output) throw new Usage("--github-output");
  const auth = vercelAuth(deps.env);

  let configured: SnapshotPair | undefined;
  try {
    configured = pairFrom(parseDotenv(deps.readText(envFile)));
  } catch {
    deps.stderr("ops: env_file_unreadable");
    return 1;
  }
  const decision = await decide({
    sha,
    force: flags.has("--force"),
    deps: {
      live: async () => {
        const lookup = await livePair(auth, deps.fetch);
        if (lookup.status === "unavailable")
          deps.stderr("ops: live_pair_unavailable");
        return lookup.status === "pair" ? lookup.pair : undefined;
      },
      projectPair: () => configured,
      commitKnown: deps.commitKnown,
      changed: deps.pathsChanged,
    },
  });
  const lines = [
    `rebuild=${String(decision.rebuild)}`,
    `reason=${decision.reason}`,
    `repair=${String(decision.repair)}`,
    ...(decision.pair === undefined
      ? []
      : [
          `snapshot-id=${decision.pair.snapshotId}`,
          `image-digest=${decision.pair.imageDigest}`,
          `commit=${decision.pair.commit}`,
        ]),
    ...(decision.previous === undefined
      ? []
      : [`previous-snapshot-id=${decision.previous.snapshotId}`]),
  ];
  deps.appendText(output, `${lines.join("\n")}\n`);
  deps.stderr(
    `ops: decided rebuild=${String(decision.rebuild)} reason=${decision.reason} repair=${String(decision.repair)}`,
  );
  return 0;
}

async function runPersist(
  argv: readonly string[],
  deps: OpsDeps,
): Promise<number> {
  const { values } = parseOptions(argv, ["--from-deployment"], []);
  const { env } = deps;
  required(env, [
    "INFISICAL_DOMAIN",
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "INFISICAL_PROJECT_SLUG",
  ]);
  let pair: SnapshotPair | undefined;
  const deployment = values.get("--from-deployment");
  if (deployment !== undefined) {
    const lookup: PairLookup = await pairOfDeployment(
      vercelAuth(env),
      deployment,
      deps.fetch,
    );
    if (lookup.status === "unavailable") {
      deps.stderr("ops: deployment_lookup_failed");
      return 1;
    }
    if (lookup.status === "none") {
      deps.stderr("ops: deployment_without_pair, nothing was written");
      return 0;
    }
    pair = lookup.pair;
  } else {
    pair = pairFromValues(
      env.PAIR_SNAPSHOT_ID,
      env.PAIR_IMAGE_DIGEST,
      env.PAIR_COMMIT,
    );
    if (pair === undefined)
      throw new Usage("PAIR_SNAPSHOT_ID, PAIR_IMAGE_DIGEST and PAIR_COMMIT");
  }
  const result = await persistPair(
    {
      domain: env.INFISICAL_DOMAIN as string,
      clientId: env.INFISICAL_CLIENT_ID as string,
      clientSecret: env.INFISICAL_CLIENT_SECRET as string,
      projectSlug: env.INFISICAL_PROJECT_SLUG as string,
    },
    pair,
    deps.fetch,
  );
  if (!result.ok) {
    deps.stderr(`ops: ${result.code}`);
    return 1;
  }
  deps.stderr("ops: pair_persisted");
  return 0;
}

const DEPLOYMENT =
  /^(dpl_[A-Za-z0-9]{8,64}|(https:\/\/)?[a-z0-9-]+\.vercel\.app)$/;

async function runVerify(
  argv: readonly string[],
  deps: OpsDeps,
): Promise<number> {
  const { values } = parseOptions(argv, ["--deployment"], []);
  const deployment = values.get("--deployment");
  if (deployment === undefined || !DEPLOYMENT.test(deployment))
    throw new Usage("--deployment");
  const answer = await productionDeployment(
    vercelAuth(deps.env),
    deployment.replace(/^https:\/\//, ""),
    deps.fetch,
  );
  if (answer === "unavailable") {
    deps.stderr("ops: deployment_lookup_failed");
    return 1;
  }
  if (answer === "no") {
    deps.stderr("ops: deployment_not_production");
    return 1;
  }
  return 0;
}

async function runCleanup(
  argv: readonly string[],
  deps: OpsDeps,
): Promise<number> {
  parseOptions(argv, [], []);
  const { env } = deps;
  const auth = vercelAuth(env);
  const keep = (env.KEEP_SNAPSHOT_IDS ?? "")
    .split(/\s+/)
    .filter((id) => id !== "");
  const discard = env.DISCARD_SNAPSHOT_ID || undefined;
  if (
    keep.some((id) => !isSnapshotId(id)) ||
    (discard !== undefined && !isSnapshotId(discard))
  )
    throw new Usage("KEEP_SNAPSHOT_IDS");

  // What production runs is never removed. If it cannot be read it could be exactly what is about to go: stop.
  const live = await livePair(auth, deps.fetch);
  if (live.status === "unavailable") {
    deps.stderr("ops: cleanup_refused, the live deployment could not be read");
    return 1;
  }
  if (live.status === "pair") keep.push(live.pair.snapshotId);

  const service = await deps.createService({
    token: auth.token,
    teamId: auth.teamId,
    projectId: auth.projectId,
  });
  const plan = planCleanup(await service.listBuilders(BUILDER_PREFIX), {
    keep,
    ...(discard === undefined ? {} : { discard }),
  });
  if (plan.refused !== undefined) {
    deps.stderr(`ops: cleanup_refused, ${plan.refused}`);
    return 1;
  }
  if (plan.unmanaged.length > 0) deps.stderr("ops: builder_without_snapshot");
  let failed = 0;
  for (const builder of plan.remove) {
    try {
      await service.deleteBuilder(builder.name);
    } catch {
      failed += 1;
    }
  }
  deps.stderr(
    `ops: cleanup removed=${String(plan.remove.length - failed)} kept=${String(plan.keep.length)}`,
  );
  if (failed > 0) {
    deps.stderr("ops: cleanup_incomplete");
    return 1;
  }
  return 0;
}

export async function runOps(
  argv: readonly string[],
  deps: OpsDeps,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "decide") return await runDecide(rest, deps);
    if (command === "persist") return await runPersist(rest, deps);
    if (command === "verify") return await runVerify(rest, deps);
    if (command === "cleanup") return await runCleanup(rest, deps);
    throw new Usage("command");
  } catch (error) {
    if (error instanceof Usage) {
      deps.stderr(`ops: usage_invalid (${error.message})`);
      return 2;
    }
    // Never the text of an error: it may carry a value.
    deps.stderr("ops: unexpected_error");
    return 1;
  }
}
