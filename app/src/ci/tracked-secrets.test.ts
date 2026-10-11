// SPDX-License-Identifier: Apache-2.0

// Scans every file that git tracks or would track (not ignored; documentation and examples included)
// for private key blocks and the shapes of well-known access tokens. Test values in this repository are fixed dummies or are
// generated while a test runs, so a hit means a real secret, or something that looks like one, was
// committed. Placeholders such as "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END ..." in the
// documentation have no key body and do not match.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// A BEGIN line for any kind of private key followed (after optional line breaks, real or written as
// \n) by at least 40 characters of base64 body, or by the header of an encrypted legacy PEM.
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\s|\\n|\\r)*(?:[A-Za-z0-9+/=]{40,}|Proc-Type:)/;

const TOKEN_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  {
    name: "GitHub fine-grained token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  },
  { name: "OpenRouter key", pattern: /\bsk-or-v1-[A-Za-z0-9]{20,}/ },
  { name: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI style key", pattern: /\bsk-[A-Za-z0-9]{40,}/ },
  {
    name: "JSON web token",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

function trackedTextFiles(): { path: string; content: string }[] {
  const listing = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const files: { path: string; content: string }[] = [];
  for (const path of listing.split("\0")) {
    if (path === "") continue;
    let buffer: Buffer;
    try {
      buffer = readFileSync(`${repoRoot}${path}`);
    } catch {
      continue; // listed by git but deleted in the working tree (not staged yet)
    }
    if (buffer.includes(0)) continue; // binary
    files.push({ path, content: buffer.toString("utf8") });
  }
  return files;
}

function findHits(files: { path: string; content: string }[]): string[] {
  const hits: string[] = [];
  for (const { path, content } of files) {
    if (PRIVATE_KEY_BLOCK.test(content))
      hits.push(`${path}: private key block`);
    for (const { name, pattern } of TOKEN_PATTERNS)
      if (pattern.test(content)) hits.push(`${path}: ${name}`);
  }
  return hits;
}

describe("files tracked by git", () => {
  // CR-38-T05
  it("hold no private key and no access token", () => {
    const files = trackedTextFiles();

    expect(files.length).toBeGreaterThan(50);
    expect(files.map((file) => file.path)).toContain("README.md");
    expect(findHits(files)).toEqual([]);
  });

  // CR-38-T05
  it("would be caught if a key or a token were committed", () => {
    const body = "A".repeat(64);
    // Joined at run time, so that this file does not contain the header it looks for.
    const legacyBegin = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");
    const planted = [
      {
        path: "docs/leak.md",
        content: `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`,
      },
      {
        path: ".env.example",
        content: `GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n${body}\\n-----END PRIVATE KEY-----"`,
      },
      {
        path: "legacy.pem",
        content: `${legacyBegin}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0123456789ABCDEF\n\n${body}\n-----END RSA PRIVATE KEY-----`,
      },
      { path: "a.ts", content: `const t = "ghs_${"a1".repeat(20)}";` },
      { path: "b.ts", content: `const t = "github_pat_${"a1".repeat(20)}";` },
      { path: "c.ts", content: `const t = "sk-or-v1-${"a1".repeat(20)}";` },
      { path: "d.ts", content: `const t = "sk-ant-${"a1".repeat(20)}";` },
      { path: "e.ts", content: `const t = "sk-${"a1".repeat(24)}";` },
      {
        path: "f.ts",
        content: `const t = "${["eyJ", "a".repeat(12)].join("")}.${["eyJ", "b".repeat(12)].join("")}.${"c".repeat(12)}";`,
      },
    ];

    expect(findHits(planted)).toEqual([
      "docs/leak.md: private key block",
      ".env.example: private key block",
      "legacy.pem: private key block",
      "a.ts: GitHub token",
      "b.ts: GitHub fine-grained token",
      "c.ts: OpenRouter key",
      "d.ts: Anthropic key",
      "e.ts: OpenAI style key",
      "f.ts: JSON web token",
    ]);
  });

  // CR-38-T05
  it("may show a key block as a placeholder without a body", () => {
    const placeholder =
      'GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----"';

    expect(findHits([{ path: "x.md", content: placeholder }])).toEqual([]);
  });
});
