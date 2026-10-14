// SPDX-License-Identifier: Apache-2.0

// Pins down the two images of runner/Dockerfile (#202): the default target is the PR-Agent-only
// runner and carries nothing of the engine; the `dynamic` target adds the pinned OpenCode, `nft`, a
// pinned `rg` and the dedicated engine user, installed root-owned from verified, checksum-pinned
// downloads. Whether the built images behave (checksums, version as the engine user, the self-check)
// is proven by docker/smoke/runner.sh, which CI runs on both.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dockerfile = readFileSync(`${repoRoot}runner/Dockerfile`, "utf8");

type Stage = { name: string; base: string; lines: string[] };

/** Stages of a Dockerfile, each with its instructions (comments dropped, continued lines joined). */
function stages(source: string): Stage[] {
  const lines = source
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line !== "" && !line.startsWith("#"));
  const found: Stage[] = [];
  for (const line of lines) {
    const from = /^FROM (\S+) AS (\S+)$/.exec(line);
    if (from)
      found.push({ name: from[2] ?? "", base: from[1] ?? "", lines: [] });
    else found.at(-1)?.lines.push(line);
  }
  return found;
}

function stage(name: string): Stage {
  const found = stages(dockerfile).find((entry) => entry.name === name);
  if (!found) throw new Error(`no stage ${name}`);
  return found;
}

/** Everything a stage and the stages it is built on contribute. */
function chain(name: string): string {
  const own = stage(name);
  const parent = stages(dockerfile).find((entry) => entry.name === own.base);
  return [parent ? chain(parent.name) : "", ...own.lines].join("\n");
}

describe("the default runner image", () => {
  // #202-T03
  it("is the last stage, so a plain build gives the PR-Agent-only runner", () => {
    expect(stages(dockerfile).at(-1)?.name).toBe("runtime");
  });

  // #202-T03
  it("carries nothing of the engine: no OpenCode, no ripgrep, no nft, no engine user", () => {
    const image = chain("runtime");

    expect(image).not.toMatch(
      /opencode|ripgrep|nftables|engine-tools|10101|\brg\b/i,
    );
    expect(image).not.toMatch(/useradd.*engine|groupadd.*engine/);
  });

  // #202-T03
  it("enables nothing: no Dynamic variable is set in either image", () => {
    for (const name of ["runtime", "dynamic"]) {
      const settings = chain(name)
        .split("\n")
        .filter((line) => /^(ENV|ARG) /.test(line));

      expect(settings.join("\n")).not.toMatch(
        /RUNNER_DYNAMIC|RUNNER_OPENCODE|RUNNER_DIFF_JOB_USER|RUNNER_ADVERTISED/,
      );
    }
  });
});

describe("the dynamic runner image", () => {
  const image = () => chain("dynamic");

  // #202-T01
  it("is built from the same base as the default image, not from it", () => {
    expect(stage("dynamic").base).toBe("runtime-base");
    expect(stage("runtime").base).toBe("runtime-base");
  });

  // #202-T01
  it("installs the engine and ripgrep root-owned from the verified fetch stage, and nothing else", () => {
    const copies = stage("dynamic").lines.filter((line) =>
      line.startsWith("COPY "),
    );

    expect(copies).toContain(
      "COPY --from=engine-tools --chown=0:0 --chmod=0755 /engine-tools/opencode /usr/local/bin/opencode",
    );
    expect(copies).toContain(
      "COPY --from=engine-tools --chown=0:0 --chmod=0755 /engine-tools/rg /usr/local/bin/rg",
    );
  });

  // #202-T01
  it("fetches only through the pinned, checksum-verifying scripts: no curl, wget, package manager or latest", () => {
    const fetching = stage("engine-tools").lines.join("\n");

    expect(fetching).toContain("python /fetch/scripts/fetch_opencode.py");
    expect(fetching).toContain("python /fetch/scripts/fetch_ripgrep.py");
    expect(fetching).toContain(
      "COPY runner/opencode-pin.json runner/ripgrep-pin.json /fetch/",
    );
    expect(dockerfile).not.toMatch(/\b(curl|wget|npm|npx|bun|pnpm)\b/);
    expect(dockerfile).not.toMatch(/releases\/latest|@latest/);
    // ripgrep comes from the pinned release, never from the distribution's unpinned package.
    expect(image()).not.toMatch(/apt-get install[^\n]*ripgrep/);
  });

  // #202-T01
  it("ships the pins the runner's self-check compares the installed files with", () => {
    // The directory exists, root-owned and enterable, before the files go in: COPY would give a new
    // directory the mode of the files.
    expect(stage("dynamic").lines).toContain(
      "RUN install -d -m 0755 -o 0 -g 0 /opt/code-reviewer/pins",
    );
    expect(stage("dynamic").lines).toContain(
      "COPY --chown=0:0 --chmod=0644 runner/opencode-pin.json runner/ripgrep-pin.json /opt/code-reviewer/pins/",
    );
  });

  // #202-T01
  it("adds nft and the engine user 10101, distinct from the Diff job user 10001", () => {
    const base = chain("runtime-base");
    const own = stage("dynamic").lines.join("\n");

    expect(own).toContain(
      "apt-get install --yes --no-install-recommends nftables",
    );
    expect(own).toContain("groupadd --system --gid 10101 engine");
    expect(own).toContain(
      "useradd --system --uid 10101 --gid engine --no-create-home",
    );
    expect(own).toContain("--shell /usr/sbin/nologin engine");
    expect(base).toContain("groupadd --system --gid 10001 runner");
    expect(base).toContain("useradd --system --uid 10001 --gid runner");
  });

  // #202-T01 / #202-T03: the image alone never makes the runner a root supervisor.
  it("ends on the unprivileged user 10001: root and the capabilities come from compose.dynamic.yml", () => {
    const users = stage("dynamic").lines.filter((line) =>
      line.startsWith("USER "),
    );

    expect(users.at(-1)).toBe("USER 10001:10001");
    expect(users[0]).toBe("USER 0:0");
  });
});
