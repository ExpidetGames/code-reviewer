// SPDX-License-Identifier: Apache-2.0

// Pins down the parts of the Dockerfiles and their ignore files that must not drift: runtime
// versions that have to match the rest of the repository, digest pinning, the unprivileged user and
// the files kept out of the build context. Whether the built images really behave (start, serve,
// create the database) is proven by the smoke tests in docker/smoke/, which CI runs.
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
 * stages it extends (`FROM runtime-base AS runtime`), as one "FROM ..." block per stage. The runner
 * Dockerfile ends on a thin default stage built on a shared base (#202).
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

const appDockerfile = read("app/Dockerfile");
const runnerDockerfile = read("runner/Dockerfile");
const dockerfiles = [
  { name: "app", source: appDockerfile },
  { name: "runner", source: runnerDockerfile },
] as const;

describe("Dockerfile runtime versions", () => {
  it("builds and runs the app on the Node major version of .nvmrc", () => {
    const major = read(".nvmrc").trim().replace(/^v/, "").split(".")[0];

    expect(argDefault(appDockerfile, "NODE_IMAGE")).toMatch(
      new RegExp(`^node:${major}-bookworm-slim@sha256:[0-9a-f]{64}$`),
    );
  });

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

  it("bases every stage of the app on the one Debian image or on an earlier stage, because the native SQLite binary depends on the libc", () => {
    const froms = instructions(appDockerfile).filter((line) =>
      line.startsWith("FROM "),
    );
    const stages: string[] = [];

    expect(argDefault(appDockerfile, "NODE_IMAGE")).toContain("bookworm");
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const from of froms) {
      const [, base, , name] = from.split(" ");
      expect(
        // "scratch" is the empty image of the stage that only holds the license files.
        base === "${NODE_IMAGE}" ||
          base === "scratch" ||
          stages.includes(base ?? ""),
        from,
      ).toBe(true);
      if (name) stages.push(name);
    }
  });
});

describe("Dockerfile security", () => {
  // CR-17-T07
  it.each(dockerfiles)(
    "ends the $name image on a numeric non-root user",
    ({ source }) => {
      const users = finalImage(source)
        .split("\n")
        .filter((line) => line.startsWith("USER "));
      const last = users.at(-1)?.slice("USER ".length) ?? "";

      expect(last).toMatch(/^[1-9][0-9]*(:[1-9][0-9]*)?$/);
    },
  );

  // CR-17-T09
  it.each(dockerfiles)(
    "bakes no secret into the $name image through ARG or ENV",
    ({ source }) => {
      const declarations = instructions(source).filter((line) =>
        /^(ARG|ENV) /.test(line),
      );

      for (const declaration of declarations) {
        expect(declaration).not.toMatch(
          /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential/i,
        );
      }
    },
  );

  // CR-17-T09
  it.each(dockerfiles)(
    "copies the build context into the $name image only through a stage, never a whole host directory into the final stage",
    ({ source }) => {
      const finalStage = finalImage(source);
      const copies = finalStage
        .split("\n")
        .filter((line) => line.startsWith("COPY ") || line.startsWith("ADD "));

      expect(copies.length).toBeGreaterThan(0);
      for (const copy of copies) {
        expect(copy, copy).toContain("--from=");
      }
    },
  );
});

describe("Dockerfile app runtime", () => {
  // CR-17-T08
  it("defaults the database to /data/app.db and prepares /data for the unprivileged user", () => {
    const lines = instructions(appDockerfile);

    expect(lines.join("\n")).toContain("DATABASE_PATH=/data/app.db");
    expect(lines.find((line) => line.includes("mkdir /data"))).toContain(
      "chown app:app /data",
    );
    expect(lines).toContain("VOLUME /data");
  });

  // CR-40-T04
  it("prepares /backups as a volume of its own for the unprivileged user and points BACKUP_DIR at it", () => {
    const lines = instructions(appDockerfile);

    expect(lines.join("\n")).toContain("BACKUP_DIR=/backups");
    expect(lines.find((line) => line.includes("mkdir /data"))).toContain(
      "mkdir /data /backups",
    );
    expect(lines.find((line) => line.includes("mkdir /data"))).toContain(
      "chown app:app /data /backups",
    );
    expect(lines).toContain("VOLUME /backups");
  });

  // CR-40-T10
  it("ships the backup command line and what it needs to run on its own", () => {
    const lines = instructions(appDockerfile);

    expect(lines).toContain(
      "COPY --from=builder --chown=root:root /build/src/backup ./backup",
    );
    const prepare = lines.find((line) => line.includes("backup/package.json"));
    expect(prepare).toContain('{"type":"module"}');
    expect(prepare).toContain("ln -s");
    expect(prepare).toContain("better-sqlite3");
  });

  // #98-AD-17
  it("ships the operator's command line and puts the short name admin on the PATH", () => {
    const lines = instructions(appDockerfile);

    expect(lines).toContain(
      "COPY --from=builder --chown=root:root /build/src/admin-cli ./admin-cli",
    );
    const prepare = lines.find((line) =>
      line.includes("admin-cli/package.json"),
    );
    expect(prepare).toContain('{"type":"module"}');
    expect(prepare).toContain("/usr/local/bin/admin");
    expect(prepare).toContain("chmod 755 /usr/local/bin/admin");
    expect(prepare).toContain("exec node /srv/app/admin-cli/cli.ts");
    // The wrapper is made before the switch to the unprivileged user, so it belongs to root.
    expect(lines.indexOf(prepare ?? "")).toBeLessThan(
      lines.findIndex((line) => line.startsWith("USER ")),
    );
  });

  // CR-17-T04
  it("gives the unprivileged user a writable Next.js cache directory below the otherwise root-owned application", () => {
    const lines = instructions(appDockerfile);

    expect(lines).toContain(
      "RUN mkdir -p .next/cache && chown -R app:app .next/cache",
    );
    expect(
      lines.filter((line) => line.startsWith("COPY --from=builder")),
    ).not.toHaveLength(0);
    for (const copy of lines.filter((line) =>
      line.startsWith("COPY --from=builder"),
    )) {
      expect(copy, copy).toContain("--chown=root:root");
    }
  });

  // CR-17-T04
  it("serves on port 3000 from the standalone server", () => {
    const lines = instructions(appDockerfile);

    expect(lines.join("\n")).toContain("PORT=3000");
    expect(lines).toContain("EXPOSE 3000");
    expect(lines).toContain('CMD ["node", "server.js"]');
    expect(lines.some((line) => line.includes(".next/standalone"))).toBe(true);
  });
});

describe("license files in the images", () => {
  const LICENSE_FILES = "LICENSE NOTICE THIRD_PARTY_LICENSES.md";

  // #118-T03
  it.each(dockerfiles)(
    "copies LICENSE, NOTICE and THIRD_PARTY_LICENSES.md of the repository root into the $name image under /licenses",
    ({ source }) => {
      const lines = instructions(source);
      const finalStage = finalImage(source);

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
    },
  );

  // #118-T03
  it.each(dockerfiles)(
    "builds the $name image from the repository root, so the license files are part of the build context",
    ({ name, source }) => {
      const copies = instructions(source).filter(
        (line) => line.startsWith("COPY ") && !line.startsWith("COPY --from="),
      );

      // Every COPY from the context names its folder; none is relative to the folder of the Dockerfile.
      for (const copy of copies) {
        expect(copy, copy).toMatch(
          new RegExp(
            // Flags (--chown, --chmod) come before the sources.
            `^COPY (--\\S+ )*(${name}/|${LICENSE_FILES.replace(/\./g, "\\.")} )`,
          ),
        );
      }
      expect(copies.length).toBeGreaterThan(1);
    },
  );
});

describe("Dockerfile ignore files", () => {
  const files = [
    { name: "app", path: "app/Dockerfile.dockerignore" },
    { name: "runner", path: "runner/Dockerfile.dockerignore" },
  ] as const;

  function patterns(path: string): string[] {
    return read(path)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  }

  // #118-T03
  it.each(files)(
    "keeps everything but the $name folder and the license files out of the build context",
    ({ name, path }) => {
      const entries = patterns(path);

      // Default deny first, then the parts that are let back in (the last matching rule wins).
      expect(entries.slice(0, 5)).toEqual([
        "*",
        `!${name}`,
        "!LICENSE",
        "!NOTICE",
        "!THIRD_PARTY_LICENSES.md",
      ]);
    },
  );

  it("is the file BuildKit reads for the Dockerfile next to it, and no .dockerignore is left in the folders", () => {
    for (const { name } of files) {
      expect(
        statSync(`${repoRoot}${name}/Dockerfile.dockerignore`).isFile(),
      ).toBe(true);
      expect(existsSync(`${repoRoot}${name}/.dockerignore`)).toBe(false);
    }
  });

  // CR-17-T09
  it.each(files)(
    "keeps environment files, keys and local databases out of the $name build context",
    ({ path }) => {
      const entries = patterns(path);

      // Without **/ a pattern only matches the root of the context, not app/public/x.pem.
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
    },
  );

  // CR-17-T09
  it.each(files)(
    "keeps host dependencies and tests out of the $name build context",
    ({ name, path }) => {
      const entries = patterns(path);

      expect(entries).toContain(
        name === "app" ? "**/node_modules" : "runner/.venv",
      );
      expect(entries).toContain(name === "app" ? "app/e2e" : "runner/tests");
    },
  );
});

describe("root .dockerignore for the classic builder", () => {
  function patterns(path: string): string[] {
    return read(path)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  }
  const root = patterns(".dockerignore");

  // #118-T03 (review of PR #136)
  it("lets only the app and runner folders and the license files into the build context", () => {
    expect(root.slice(0, 6)).toEqual([
      "*",
      "!app",
      "!runner",
      "!LICENSE",
      "!NOTICE",
      "!THIRD_PARTY_LICENSES.md",
    ]);
    expect(root.filter((entry) => entry.startsWith("!"))).toHaveLength(5);
  });

  // #118-T03 (review of PR #136)
  it.each(["app", "runner"])(
    "excludes everything that the %s ignore file excludes, because the classic builder reads only this file",
    (name) => {
      const own = patterns(`${name}/Dockerfile.dockerignore`).filter(
        (entry) => entry !== "*" && !entry.startsWith("!"),
      );

      expect(own.filter((entry) => !root.includes(entry))).toEqual([]);
    },
  );
});

describe("the dynamic stage of the runner Dockerfile", () => {
  // CR-17-T09, #202: the `dynamic` target is not the last stage, so the guard above never sees it.
  it("copies the build context only through a stage, except the two pin files", () => {
    expect(contextCopyViolations(runnerDockerfile, "dynamic")).toEqual([]);
  });

  it("flags a whole host directory copied into the dynamic stage", () => {
    const broad = runnerDockerfile.replace(
      "COPY --chown=0:0 --chmod=0644 runner/opencode-pin.json runner/ripgrep-pin.json /opt/code-reviewer/pins/",
      "COPY --chown=0:0 runner /opt/code-reviewer/pins/",
    );

    expect(broad).not.toBe(runnerDockerfile);
    expect(contextCopyViolations(broad, "dynamic")).toEqual([
      "COPY --chown=0:0 runner /opt/code-reviewer/pins/",
    ]);
  });

  it("flags a pin file path that is a wildcard", () => {
    const wildcard = runnerDockerfile.replace(
      "--chmod=0644 runner/opencode-pin.json runner/ripgrep-pin.json",
      "--chmod=0644 runner/*-pin.json",
    );

    expect(wildcard).not.toBe(runnerDockerfile);
    expect(contextCopyViolations(wildcard, "dynamic")).toHaveLength(1);
  });
});
