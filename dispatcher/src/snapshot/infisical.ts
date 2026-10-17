// SPDX-License-Identifier: Apache-2.0

// Writes the golden snapshot pair to Infisical, `prod` `/dispatcher` (#403), after a deployment is live, so that the
// next deployment and Secret Sync know which snapshot production runs. It signs in with the machine identity of the
// workflows (Universal Auth) and touches exactly three secrets: the names are fixed here, the identity's role should
// say the same (docs/deployment-vercel.md, section 2.1). The client secret goes to the one https address it is
// given, nothing is read back, no error text is ever repeated and no value is logged. A secret that does not exist
// yet is created (the first deployment).
import { PAIR_VARIABLES, pairToEnv, type SnapshotPair } from "./pair.ts";

export type InfisicalTarget = {
  /** `https://<host>` of the Infisical instance. */
  domain: string;
  clientId: string;
  clientSecret: string;
  projectSlug: string;
};

export type PersistResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "infisical_domain_invalid"
        | "infisical_unreachable"
        | "infisical_sign_in_failed"
        | "infisical_project_unavailable"
        | "infisical_write_failed";
    };

const ENVIRONMENT = "prod";
const SECRET_PATH = "/dispatcher";
/** The only names this module ever writes, in the order it writes them. */
const NAMES = [
  PAIR_VARIABLES.snapshotId,
  PAIR_VARIABLES.imageDigest,
  PAIR_VARIABLES.commit,
] as const;

class Unreachable extends Error {}

function base(domain: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(domain);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  return url;
}

async function call(
  request: typeof fetch,
  url: URL,
  method: "GET" | "POST" | "PATCH",
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  let answer: Response;
  try {
    answer = await request(url, {
      method,
      headers:
        body === undefined
          ? headers
          : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Unreachable();
  }
  let json: unknown;
  try {
    json = await answer.json();
  } catch {
    json = undefined;
  }
  return { status: answer.status, json };
}

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;

export async function persistPair(
  target: InfisicalTarget,
  pair: SnapshotPair,
  request: typeof fetch = fetch,
): Promise<PersistResult> {
  const root = base(target.domain);
  if (root === undefined)
    return { ok: false, code: "infisical_domain_invalid" };
  try {
    const login = await call(
      request,
      new URL("/api/v1/auth/universal-auth/login", root),
      "POST",
      {},
      { clientId: target.clientId, clientSecret: target.clientSecret },
    );
    const accessToken = field(login.json, "accessToken");
    if (
      login.status !== 200 ||
      typeof accessToken !== "string" ||
      accessToken === ""
    )
      return { ok: false, code: "infisical_sign_in_failed" };
    const auth = { authorization: `Bearer ${accessToken}` };

    const project = await call(
      request,
      new URL(
        `/api/v1/projects/slug/${encodeURIComponent(target.projectSlug)}`,
        root,
      ),
      "GET",
      auth,
    );
    const projectId = field(project.json, "id");
    if (
      project.status !== 200 ||
      typeof projectId !== "string" ||
      projectId === ""
    )
      return { ok: false, code: "infisical_project_unavailable" };

    const values = pairToEnv(pair);
    for (const name of NAMES) {
      const url = new URL(`/api/v4/secrets/${name}`, root);
      const body = {
        projectId,
        environment: ENVIRONMENT,
        secretPath: SECRET_PATH,
        secretValue: values[name],
        type: "shared",
      };
      let written = await call(request, url, "PATCH", auth, body);
      if (written.status === 404)
        written = await call(request, url, "POST", auth, body);
      // 200 with an `approval` is a change that waits for a person: it is not written.
      if (
        written.status !== 200 ||
        field(written.json, "approval") !== undefined
      )
        return { ok: false, code: "infisical_write_failed" };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof Unreachable)
      return { ok: false, code: "infisical_unreachable" };
    throw error;
  }
}
