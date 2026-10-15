// SPDX-License-Identifier: Apache-2.0

// The last word of the hosted lane (#332-T10): after every journey has run, no credential is in any log of any
// component. The components are the app (its log file), every Dispatcher the journeys started (their output, kept in one
// file), and every Worker and canary container (what the stand-in `docker` recorded: the flags, the environment the
// Worker had, and what it wrote). The credentials are the dispatcher credential, the signing secret of the wake-up call,
// the cron secret, the master key, the GitHub App's secrets and key, the instance admin's password, the workspace's LLM
// key, every installation token the fake GitHub issued, and anything shaped like a per-job credential (`crj_...`).
//
// A scan that finds nothing proves nothing when it looked at nothing: the logs must hold what a run of the journeys
// leaves in them (a claim, a launch, a Worker that reported), so a log that is empty or in the wrong place fails the
// journey instead of passing it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { e2eEnv, githubAppPrivateKey, llmEnv } from "../helpers/e2e-env";
import { getIssuedInstallationTokens } from "../helpers/github-fake";
import { hostedEnv, hostedSecrets } from "../helpers/hosted-env";

const absolute = (path: string) => resolve(process.cwd(), path);

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Every log of the lane by name: the files of the app and the Dispatchers, and every record of every container. */
function logs(): Record<string, string> {
  const result: Record<string, string> = {
    "the app's log": read(absolute(hostedEnv.logFiles.app)),
    "the Dispatchers' output": read(absolute(hostedEnv.logFiles.dispatcher)),
  };
  const directory = absolute(hostedEnv.dockerDirectory);
  if (existsSync(directory))
    for (const file of readdirSync(directory).sort())
      result[`the container record ${file}`] = read(join(directory, file));
  return result;
}

test.describe("every log of every component", () => {
  // #332-T10
  test("holds no credential of the lane, no installation token and nothing shaped like a per-job credential", async ({
    request,
  }) => {
    const everything = logs();
    const names = Object.keys(everything);

    // The scan looked at something: what the journeys leave in the logs is there.
    expect(everything["the app's log"]).toContain("credential issued");
    expect(everything["the Dispatchers' output"]).toContain(
      '"event":"launched"',
    );
    expect(
      names.filter((name) => /container record run-\d+\.log$/.test(name))
        .length,
    ).toBeGreaterThan(3);
    expect(
      names.some(
        (name) =>
          /run-\d+\.log$/.test(name) &&
          everything[name]?.includes("worker done: ok"),
      ),
    ).toBe(true);

    const tokens = await getIssuedInstallationTokens(request);
    expect(tokens.length).toBeGreaterThan(0);
    const secrets = [
      ...hostedSecrets(),
      llmEnv.apiKey,
      e2eEnv.githubAppWebhookSecret,
      e2eEnv.githubClientSecret,
      e2eEnv.adminPassword,
      githubAppPrivateKey(),
      ...tokens,
    ];
    for (const [name, text] of Object.entries(everything)) {
      for (const secret of secrets)
        expect(text, `a credential is in ${name}`).not.toContain(secret);
      expect(text, `a private key is in ${name}`).not.toContain(
        "BEGIN RSA PRIVATE KEY",
      );
      expect(text, `a per-job credential is in ${name}`).not.toMatch(
        /crj_[A-Za-z0-9_-]{8,}/,
      );
    }
  });
});
