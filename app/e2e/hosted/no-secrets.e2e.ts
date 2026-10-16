// SPDX-License-Identifier: Apache-2.0

// The last word of the hosted lane (#332-T10): after every journey has run, no credential is in any log of any
// component, and no Worker connected to anything but loopback (the second test: the runner's connect guard recorded every
// connection of the Worker hosts and the job processes). The components are the app (its log file), every Dispatcher the journeys started (their output, kept in one
// file), and every Worker and canary container (what the stand-in `docker` recorded: the flags, the environment the
// Worker had, and what it wrote). The credentials are the dispatcher credential, the signing secret of the wake-up call,
// the cron secret, the master key, the GitHub App's secrets and key, the instance admin's password, the workspace's LLM
// key, every installation token the fake GitHub issued, and anything shaped like a per-job credential (`crj_...`).
//
// The Dispatcher's output is what its own masker lets through; the masker's tests prove it, and the raw lines before it
// do not exist outside the process. What the masker does not cover is scanned as it is: the app's log, the flags,
// the environment and the log of every container.
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
import {
  allSecrets,
  containsSecret,
  perJobCredentials,
} from "../helpers/hosted-secrets";

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
      // What the lane learned on the way: the credential of every job (the stand-in kept a copy of each start
      // document), the session cookies and the setup code.
      ...allSecrets(),
    ];
    // The credentials searched for are real ones: one per Worker that ran, in the shape of a per-job credential.
    const credentials = perJobCredentials();
    expect(credentials.length).toBeGreaterThanOrEqual(
      names.filter(
        (name) =>
          /run-\d+\.log$/.test(name) &&
          everything[name]?.includes("worker done: ok"),
      ).length,
    );
    expect(
      credentials.every((value) => /^crj_[A-Za-z0-9_-]{20,}$/.test(value)),
    ).toBe(true);
    for (const [name, text] of Object.entries(everything)) {
      for (const secret of secrets)
        expect(containsSecret(text, secret), `a credential is in ${name}`).toBe(
          false,
        );
      expect(text, `a private key is in ${name}`).not.toContain(
        "BEGIN RSA PRIVATE KEY",
      );
      expect(text, `a per-job credential is in ${name}`).not.toMatch(
        /crj_[A-Za-z0-9_-]{8,}/,
      );
    }
  });
});

test.describe("every connection of a Worker", () => {
  // #332-T10
  test("went to loopback: the Worker host to the app, the job process to the two fakes, nothing else", async () => {
    const lines = readFileSync(absolute(hostedEnv.connectionLog), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            target: string;
            allowed: boolean;
          },
      );

    // The guard recorded something, and from both kinds of process: the Worker host (the app's port) and the job
    // process (the fake GitHub and the fake LLM), so a guard that was never loaded cannot pass.
    const ports = new Set(
      lines.map((line) =>
        Number(line.target.slice(line.target.lastIndexOf(":") + 1)),
      ),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(ports.has(hostedEnv.appPort)).toBe(true);
    expect(ports.has(e2eEnv.githubPort)).toBe(true);
    expect(ports.has(e2eEnv.modelLlmFakePort)).toBe(true);
    for (const line of lines) {
      expect(line.allowed, `${line.kind} to ${line.target}`).toBe(true);
      expect(line.target.startsWith("127.0.0.1:"), line.target).toBe(true);
    }
  });
});
