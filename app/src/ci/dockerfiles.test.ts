// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the parts of the Dockerfile of the Worker image and its ignore file that must not drift:
// runtime versions that have to match the rest of the repository, digest pinning, the unprivileged
// user and the files kept out of the build context. Whether the built image really behaves is proven
// by the smoke test in docker/smoke/, which CI runs.
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

/** The instructions of a Dockerfile as "KEYWORD rest" strings: comments dropped, continued lines joined. */
function instructions(dockerfile: string): string[] {
  const joined = dockerfile.replace(/\\\n/g, " ");
  return joined
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/\s+/g, " "));
}

/**
 * The instructions that make up the image of the final stage: those of the stage itself and of the
 * stages it extends (`FROM runtime-base AS sandbox`), as one "FROM ..." block per stage.
 */
function finalImage(dockerfile: string): string {
  const blocks = instructions(dockerfile)
    .join("\n")
    .split(/^FROM /m)
    .slice(1);
  let image = blocks.at(-1) ?? "";
  let base = image.split(" ")[0] ?? "";
  for (;;) {
    const parent = blocks.find((block) => block.includes(` AS ${base}\n`));
    if (!parent) return image;
    image = `${parent}\n${image}`;
    base = parent.split(" ")[0] ?? "";
  }
}

/**
 * The COPY and ADD instructions of the image of one named stage (and its parents) that read the build
 * context other than through `--from=` and other than the pin files the stage names exactly.
 */
function contextCopyViolations(dockerfile: string, target: string): string[] {
  const blocks = instructions(dockerfile)
    .join("\n")
    .split(/^FROM /m)
    .slice(1);
  const own = blocks.find((block) => block.includes(` AS ${target}\n`));
  if (!own) throw new Error(`no stage ${target}`);
  const chain: string[] = [own];
  for (;;) {
    const base = chain[0]?.split(" ")[0] ?? "";
    const parent = blocks.find((block) => block.includes(` AS ${base}\n`));
    if (!parent) break;
    chain.unshift(parent);
  }
  return chain
    .flatMap((block) => block.split("\n"))
    .filter((line) => line.startsWith("COPY ") || line.startsWith("ADD "))
    .filter((line) => !line.includes("--from="))
    .filter((line) => {
      const sources = line
        .split(" ")
        .slice(1)
        .filter((word) => !word.startsWith("--"))
        .slice(0, -1);
      return !sources.every((source) =>
        /^runner\/[a-z]+-pin\.json$/.test(source),
      );
    });
}

function argDefault(dockerfile: string, name: string): string {
  const line = instructions(dockerfile).find((entry) =>
    entry.startsWith(`ARG ${name}=`),
  );
  if (!line) throw new Error(`no ARG ${name} with a default`);
  return line.slice(`ARG ${name}=`.length);
}

const runnerDockerfile = read("runner/Dockerfile");

describe("Dockerfile runtime versions", () => {
  it("runs the runner on the Python version of runner/.python-version", () => {
    const version = read("runner/.python-version").trim();

    expect(argDefault(runnerDockerfile, "PYTHON_IMAGE")).toMatch(
      new RegExp(
        `^python:${version.replace(".", "\\.")}-slim-bookworm@sha256:[0-9a-f]{64}$`,
      ),
    );
  });

  it("installs the runner with the uv version that CI uses", () => {
    const ci = parse(read(".github/workflows/ci.yml")) as {
      jobs: Record<
        string,
        { steps?: { uses?: string; with?: { version?: string } }[] }
      >;
    };
    const setupUv = ci.jobs["runner-fast"]?.steps?.find((step) =>
      step.uses?.startsWith("astral-sh/setup-uv@"),
    );

    expect(argDefault(runnerDockerfile, "UV_IMAGE")).toMatch(
      new RegExp(
        `^ghcr\\.io/astral-sh/uv:${setupUv?.with?.version?.replace(/\./g, "\\.")}@sha256:[0-9a-f]{64}$`,
      ),
    );
  });
});

describe("Dockerfile security", () => {
  // CR-17-T07
  it("ends the image on a numeric non-root user", () => {
    const users = finalImage(runnerDockerfile)
      .split("\n")
      .filter((line) => line.startsWith("USER "));
    const last = users.at(-1)?.slice("USER ".length) ?? "";

    expect(last).toMatch(/^[1-9][0-9]*(:[1-9][0-9]*)?$/);
  });

  // CR-17-T09
  it("bakes no secret into the image through ARG or ENV", () => {
    const declarations = instructions(runnerDockerfile).filter((line) =>
      /^(ARG|ENV) /.test(line),
    );

    for (const declaration of declarations) {
      expect(declaration).not.toMatch(
        /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential/i,
      );
    }
  });

  // CR-17-T09, #202: the build context is copied through a stage, except the two pin files the final stage names exactly.
  it("copies the build context only through a stage, except the two pin files", () => {
    expect(contextCopyViolations(runnerDockerfile, "sandbox")).toEqual([]);
  });

  it("flags a whole host directory copied into the final stage", () => {
    const broad = runnerDockerfile.replace(
      "COPY --chown=0:0 --chmod=0644 runner/opencode-pin.json runner/ripgrep-pin.json /opt/code-reviewer/pins/",
      "COPY --chown=0:0 runner /opt/code-reviewer/pins/",
    );

    expect(broad).not.toBe(runnerDockerfile);
    expect(contextCopyViolations(broad, "sandbox")).toEqual([
      "COPY --chown=0:0 runner /opt/code-reviewer/pins/",
    ]);
  });

  it("flags a pin file path that is a wildcard", () => {
    const wildcard = runnerDockerfile.replace(
      "--chmod=0644 runner/opencode-pin.json runner/ripgrep-pin.json",
      "--chmod=0644 runner/*-pin.json",
    );

    expect(wildcard).not.toBe(runnerDockerfile);
    expect(contextCopyViolations(wildcard, "sandbox")).toHaveLength(1);
  });
});

describe("license files in the image", () => {
  const LICENSE_FILES = "LICENSE NOTICE THIRD_PARTY_LICENSES.md";

  // #118-T03
  it("copies LICENSE, NOTICE and THIRD_PARTY_LICENSES.md of the repository root into the image under /licenses", () => {
    const lines = instructions(runnerDockerfile);
    const finalStage = finalImage(runnerDockerfile);

    expect(lines).toContain("FROM scratch AS licenses");
    expect(lines).toContain(`COPY ${LICENSE_FILES} /`);
    expect(
      finalStage
        .split("\n")
        .some(
          (line) =>
            line.startsWith("COPY --from=licenses ") &&
            line.endsWith(" / /licenses/"),
        ),
    ).toBe(true);
  });

  // #118-T03
  it("builds the image from the repository root, so the license files are part of the build context", () => {
    const copies = instructions(runnerDockerfile).filter(
      (line) => line.startsWith("COPY ") && !line.startsWith("COPY --from="),
    );

    // Every COPY from the context names its folder; none is relative to the folder of the Dockerfile.
    for (const copy of copies) {
      expect(copy, copy).toMatch(
        new RegExp(
          // Flags (--chown, --chmod) come before the sources.
          `^COPY (--\\S+ )*(runner/|${LICENSE_FILES.replace(/\./g, "\\.")} )`,
        ),
      );
    }
    expect(copies.length).toBeGreaterThan(1);
  });
});

describe("Dockerfile ignore file", () => {
  const path = "runner/Dockerfile.dockerignore";

  function patterns(): string[] {
    return read(path)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  }

  // #118-T03
  it("keeps everything but the runner folder and the license files out of the build context", () => {
    // Default deny first, then the parts that are let back in (the last matching rule wins).
    expect(patterns().slice(0, 5)).toEqual([
      "*",
      "!runner",
      "!LICENSE",
      "!NOTICE",
      "!THIRD_PARTY_LICENSES.md",
    ]);
  });

  it("is the file BuildKit reads for the Dockerfile next to it, and no .dockerignore is left anywhere", () => {
    expect(statSync(`${repoRoot}${path}`).isFile()).toBe(true);
    expect(existsSync(`${repoRoot}runner/.dockerignore`)).toBe(false);
    expect(existsSync(`${repoRoot}.dockerignore`)).toBe(false);
  });

  // CR-17-T09
  it("keeps environment files, keys and local databases out of the build context", () => {
    const entries = patterns();

    // Without **/ a pattern only matches the root of the context, not runner/x.pem.
    for (const pattern of [
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.key",
      "**/*.p12",
      "**/*.db",
      "**/.git",
    ]) {
      expect(entries, pattern).toContain(pattern);
    }
    expect(entries).not.toContain("!.env.example");
    expect(entries.filter((entry) => entry.startsWith("!"))).toHaveLength(4);
  });

  // CR-17-T09
  it("keeps host dependencies and tests out of the build context", () => {
    const entries = patterns();

    expect(entries).toContain("runner/.venv");
    expect(entries).toContain("runner/tests");
  });
});
