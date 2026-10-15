// SPDX-License-Identifier: Apache-2.0

// The hosted deployment's Dynamic Review in the privileged lane (#332-T02, and the `worker-once` and `probe` modes end to
// end that #324 and #331 left for it): the deploy canary passes first, then a signed `opened` webhook reaches the app
// (in the dispatch mode of the hosted deployment), the app wakes the REAL Dispatcher, which claims exactly that job
// because its capability probe passed, and its Sandbox-Launcher starts the Worker through the stand-in `docker` in the
// way of the hardened container: root with exactly the eight capabilities of the spec, no-new-privileges and a read-only
// root (runner/scripts/dynamic_e2e_worker_container.sh). The REAL Worker (`worker-once`) runs its own startup (the
// engine user's network rules, the end of NET_ADMIN, the self-check on the pinned OpenCode), fetches its job with the
// per-job credential and runs the REAL OpenCode as the engine user behind its model proxy; one summary comment lands on
// the fake pull request. Nothing is replaced but the container itself and the platform behind it; the network guard of
// the lane counts every attempt to leave loopback, of the Dispatcher, the Worker and the engine alike.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createGitRepository,
  type GitRepository,
} from "../../../fakes/github/git-fixture.ts";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import {
  changeAdminSetting,
  syncFromGithubAsAdmin,
} from "../helpers/admin-api";
import { engineProcesses } from "../helpers/dynamic-runner";
import {
  assertNoExternalAttempts,
  readGuard,
} from "../helpers/dynamic-lane-guard";
import { e2eEnv, llmEnv } from "../helpers/e2e-env";
import {
  addGithubGitRepository,
  addGithubInstallation,
  addGithubPullRequest,
  GITHUB_APP_OWNER_ACCOUNT,
  getIssuedInstallationTokens,
  getPullRequestComments,
} from "../helpers/github-fake";
import {
  startHostedDispatcher,
  type HostedDispatcher,
} from "../helpers/hosted-dispatcher";
import { hostedEnv } from "../helpers/hosted-env";
import {
  chooseDynamicReview,
  eventually,
  OWNER,
  runDeployCanary,
  saveWorkspaceKey,
  signInAsAdmin,
  switchProjectOn,
} from "../helpers/hosted-instance";
import { openRuns, required, runsOf } from "../helpers/hosted-journey";
import { deliverPullRequestEvent } from "../helpers/webhooks";

const WRAPPER = resolve(
  process.cwd(),
  "../runner/scripts/dynamic_e2e_worker_container.sh",
);

const INSTALLATION_ID = 9500102;
const WIDGETS = { id: 9600102, fullName: "hosted-dynamic/widgets" };
const OWNER_OF_WIDGETS = { login: "hosted-dynamic", id: OWNER.id };
const MODEL = "vendor/agent-e2e";
const TITLE = "Add a user handler";
const BODY = "Shows a user by the name in the request.";
const FINDING_TITLE = "SQL text is built from the user name";
const IDENTITY_MARKER = "<!-- code-reviewer:dynamic-review:summary -->";
const WORKSPACE_KEY = "sk-or-v1-e2e-workspace-key-of-the-hosted-dynamic-0001";
// A real engine run takes a few seconds; the first one also starts the engine cold.
const RUN_TIMEOUT = { timeout: 200_000 };
const LOOKUP_BUGGY =
  'def find_user(connection, name):\n    query = "SELECT * FROM users WHERE name = \'" + name + "\'"\n    return connection.execute(query)\n';
const HANDLER =
  'from lookup import find_user\n\n\ndef show(connection, request):\n    return find_user(connection, request["name"])\n';

test.describe.configure({ mode: "serial" });

test.describe("a pull request on its way to a Dynamic Review summary through the hosted deployment", () => {
  let llm: FakeLlm | undefined;
  let dispatcher: HostedDispatcher | undefined;
  let directory: string | undefined;
  let repository: GitRepository | undefined;

  test.beforeAll(async ({ browser, baseURL }) => {
    if (baseURL === undefined)
      throw new Error("The hosted project has no baseURL.");
    // At the address the app asks for the metadata of the Dynamic model it saves (#269).
    llm = await startLlmFake({ port: e2eEnv.modelLlmFakePort });
    llm.setModel(MODEL, [
      {
        supported_parameters: ["tools", "tool_choice"],
        context_length: 200_000,
        pricing: { prompt: "0.0000005", completion: "0.000002" },
      },
    ]);
    // The Dispatcher of the hosted deployment, serving both engines. The Worker runs in the container's root,
    // capabilities and read-only root, started the way the container is: nothing is unset for it. The "VMs" are made in
    // the lane's own /run, which the read-only root leaves writable.
    dispatcher = await startHostedDispatcher({
      llmBaseUrl: llm.baseUrl,
      engines: "pr-agent,opencode",
      tiktoken: false,
      unsetForWorkerOnce: [],
      dynamic: {
        capabilities: JSON.stringify({
          tool_choice_required: true,
          structured_output: true,
          max_output_tokens: 4096,
          input_usd_per_mtok: 1,
          output_usd_per_mtok: 4,
        }),
        maxCostUsd: "1",
      },
      environment: {
        E2E_WORKER_WRAPPER: WRAPPER,
        E2E_WORKER_PATH:
          "/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
        E2E_VM_ROOT: "/run/hosted-vms",
        E2E_WORKER_PASS_PYTHONDONTWRITEBYTECODE: "1",
      },
    });

    // The repository of the pull request, as real Git objects the fake GitHub serves over smart HTTP.
    directory = mkdtempSync(join(tmpdir(), "cr-lane-hosted-repo-"));
    repository = createGitRepository(join(directory, "widgets"));
    const base = repository.commit(
      { "README.md": "# widgets\n", "src/lookup.py": LOOKUP_BUGGY },
      "Base",
    );
    repository.setRef("refs/heads/main", base);
    repository.branch("feature");

    // The setup a person does once: install the app, sync, save the workspace's key, switch the project on and
    // choose Dynamic Review for it (the gate is the instance admin's, and off in every shipped configuration).
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      await addGithubInstallation(
        context.request,
        { id: INSTALLATION_ID, account: GITHUB_APP_OWNER_ACCOUNT },
        [WIDGETS],
      );
      await addGithubGitRepository(
        context.request,
        WIDGETS.fullName,
        repository.path,
      );
      await syncFromGithubAsAdmin(baseURL);
      await signInAsAdmin(page);
      await saveWorkspaceKey(page, WORKSPACE_KEY);
      await switchProjectOn(page, WIDGETS.fullName);
      await changeAdminSetting(baseURL, { dynamicReview: { enabled: true } });
      await chooseDynamicReview(page, WIDGETS.fullName, MODEL);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async () => {
    try {
      await dispatcher?.stop();
    } finally {
      await llm?.close();
      if (directory !== undefined)
        rmSync(directory, { recursive: true, force: true });
    }
  });

  // #332-T02
  test("the canary passes first; a pull request is claimed by the Dispatcher, run by the Worker in the container's root and read-only root, and one summary is published", async ({
    page,
    request,
  }) => {
    const theDispatcher = required(dispatcher, "The Dispatcher");
    const theLlm = required(llm, "The fake LLM");
    const repo = required(repository, "The repository");

    // The release gate, as the pipeline runs it: the probe container (the `probe` mode of the image, in the
    // container's own layout) vouches for the hardening, and `opencode` is advertised from that.
    const canary = await runDeployCanary(150);
    expect(
      canary.code,
      `${canary.output}\n${theDispatcher.output()}\n${theDispatcher
        .containers()
        .map((container) => container.log())
        .join("\n")}`,
    ).toBe(0);
    expect(canary.output).toContain("canary: passed");
    expect(canary.output).toContain("opencode");
    expect(theDispatcher.output()).toContain('"event":"probe_passed"');

    const number = 7;
    const head = repo.commit({ "src/handlers.py": HANDLER }, "Add a handler");
    repo.setRef(`refs/pull/${String(number)}/head`, head);
    // The model: reads the file the pull request does not touch, then reports the finding in it.
    theLlm.scriptAgent({
      steps: [[{ name: "read", arguments: { filePath: "src/lookup.py" } }]],
      final: {
        schemaVersion: 1,
        reviewedSha: head,
        resolvedIds: [],
        findings: [
          {
            id: "f-1",
            priority: "P2",
            confidence: 0.8,
            title: FINDING_TITLE,
            body: "The SQL text is built by joining the name into it.",
            path: "src/lookup.py",
            lineStart: 2,
            lineEnd: 2,
            evidence: ["src/lookup.py:2"],
            reviewedSha: head,
          },
        ],
      },
    });
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number,
      title: TITLE,
      body: BODY,
      headSha: head,
    });
    await openRuns(page);

    const answer = await deliverPullRequestEvent(request, {
      action: "opened",
      installationId: INSTALLATION_ID,
      repository: { ...WIDGETS, owner: OWNER_OF_WIDGETS },
      number,
      title: TITLE,
      headSha: head,
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });

    const row = runsOf(page, WIDGETS.fullName, number);
    await expect(row.locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );

    // One summary comment, written by the bot of the app, with the finding that is outside the diff.
    const [summary, ...others] = await getPullRequestComments(
      request,
      WIDGETS.fullName,
      number,
    );
    expect(others).toEqual([]);
    expect(summary?.login).toBe(e2eEnv.githubBotLogin);
    expect(summary?.body).toContain(IDENTITY_MARKER);
    expect(summary?.body).toContain("**1 active finding(s)**");
    expect(summary?.body).toContain(FINDING_TITLE);

    // The real engine read the file outside the diff through its read tool, with the workspace's key.
    const asked = theLlm.requests();
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(
      asked.every((item) => item.authorization === `Bearer ${WORKSPACE_KEY}`),
    ).toBe(true);
    expect(
      asked.flatMap((item) => Object.values(item.toolResults)).join("\n"),
    ).toContain("def find_user(connection, name):");

    // The order of the design: the probe, then the claim and the launch, then one Worker in a container with the
    // hardened flags (the eight capabilities of the spec among them) that advertised `opencode` on its own merits.
    const log = theDispatcher.output();
    expect(log.indexOf('"event":"probe_passed"')).toBeLessThan(
      log.indexOf('"event":"launched"'),
    );
    const workers = theDispatcher
      .containers()
      .filter((container) => container.mode === "worker-once");
    expect(workers).toHaveLength(1);
    const worker = required(workers[0], "The Worker");
    const flags = worker.args.join(" ");
    for (const capability of [
      "SETUID",
      "SETGID",
      "KILL",
      "CHOWN",
      "DAC_OVERRIDE",
      "FOWNER",
      "NET_ADMIN",
      "SETPCAP",
    ])
      expect(flags).toContain(`--cap-add ${capability}`);
    expect(flags).toContain("--cap-drop ALL");
    expect(flags).toContain("--read-only");
    expect(worker.environment).toContain("RUNNER_DIFF_JOB_USER=10001:10001");
    expect(worker.log()).toContain("opencode is advertised");
    expect(worker.log()).toContain("worker done: ok");

    // No credential in the page, the Dispatcher's output, the Worker's log or what the model was shown, and nothing
    // of the Worker or the engine is left running.
    const tokens = await getIssuedInstallationTokens(request);
    expect(tokens.length).toBeGreaterThan(0);
    const texts = {
      "the page": await page.content(),
      "the Dispatcher's output": log,
      "the Worker's log": worker.log(),
      "the Worker's environment": worker.environment,
      "what the model was shown": asked.map((item) => item.prompt).join("\n"),
    };
    for (const [name, text] of Object.entries(texts))
      for (const secret of [
        WORKSPACE_KEY,
        llmEnv.apiKey,
        hostedEnv.dispatcherToken,
        hostedEnv.webhookSecret,
        ...tokens,
      ])
        expect(text, `a credential is in ${name}`).not.toContain(secret);
    expect(`${log}${worker.log()}`).not.toMatch(/crj_[A-Za-z0-9_-]{8,}/);
    await eventually(
      "the engine's processes to be gone",
      async () => engineProcesses().length === 0,
    );
    assertNoExternalAttempts(readGuard());
  });
});
