// SPDX-License-Identifier: Apache-2.0

// Pins down how the allow list is read from the environment and how a login is matched against it:
// case-insensitive, whitespace tolerant, whole logins only, and fail closed when nothing is set.
import { describe, expect, it } from "vitest";
import {
  isAccessConfigured,
  isLoginListed,
  parseAccessConfig,
} from "./access-config.ts";

function parse(env: Record<string, string | undefined>) {
  const problems: string[] = [];
  const config = parseAccessConfig(env, problems);
  return { config, problems };
}

describe("matching a login against ALLOWED_GITHUB_LOGINS", () => {
  const { config } = parse({ ALLOWED_GITHUB_LOGINS: "octocat,hubot" });

  // CR-19-T01
  it("lets a listed login in", () => {
    expect(isLoginListed(config, "hubot")).toBe(true);
  });

  // CR-19-T02
  it("keeps a login out that is not listed", () => {
    expect(isLoginListed(config, "mallory")).toBe(false);
  });

  // CR-19-T04
  it("ignores the case of the login and of the list", () => {
    const upper = parse({ ALLOWED_GITHUB_LOGINS: "OctoCat" }).config;

    expect(isLoginListed(upper, "octocat")).toBe(true);
    expect(isLoginListed(upper, "OCTOCAT")).toBe(true);
    expect(isLoginListed(config, "OctoCat")).toBe(true);
  });

  // CR-19-T05
  it("tolerates spaces and empty entries in the list, and an empty entry admits nobody", () => {
    const messy = parse({
      ALLOWED_GITHUB_LOGINS: " octocat , hubot ,,",
    }).config;

    expect(isLoginListed(messy, "octocat")).toBe(true);
    expect(isLoginListed(messy, "hubot")).toBe(true);
    expect(isLoginListed(messy, "")).toBe(false);
    expect(isLoginListed(messy, " ")).toBe(false);
  });

  // CR-19-T06
  it.each(["octocat2", "cat", "octocat-evil", "octoca", "xoctocat"])(
    "does not match %s as a part of a listed login",
    (login) => {
      const single = parse({ ALLOWED_GITHUB_LOGINS: "octocat" }).config;

      expect(isLoginListed(single, login)).toBe(false);
    },
  );

  // CR-19-T06
  it.each(["octocat\n", " octocat", "octocat ", "octo*", "*", ".*"])(
    "does not treat %j as a pattern or as a padded login",
    (login) => {
      const single = parse({ ALLOWED_GITHUB_LOGINS: "octocat,*" }).config;

      expect(isLoginListed(single, login)).toBe(login === "*");
    },
  );

  it("does not let names of Object.prototype through", () => {
    const single = parse({ ALLOWED_GITHUB_LOGINS: "octocat" }).config;

    expect(isLoginListed(single, "__proto__")).toBe(false);
    expect(isLoginListed(single, "constructor")).toBe(false);
  });
});

describe("an access configuration that admits nobody", () => {
  // CR-19-T03
  it.each([
    ["nothing set", {}],
    ["both empty", { ALLOWED_GITHUB_LOGINS: "", ALLOWED_GITHUB_ORG: "" }],
    [
      "only spaces and commas",
      { ALLOWED_GITHUB_LOGINS: " , ,, ", ALLOWED_GITHUB_ORG: "   " },
    ],
  ])("is not configured when %s, and no login is listed", (_case, env) => {
    const { config, problems } = parse(env);

    expect(problems).toEqual([]);
    expect(isAccessConfigured(config)).toBe(false);
    expect(config.org).toBeNull();
    for (const login of ["octocat", "hubot", "", " ", "*"])
      expect(isLoginListed(config, login)).toBe(false);
  });
});

describe("ALLOWED_GITHUB_ORG", () => {
  it("is read trimmed and makes the configuration count as configured", () => {
    const { config, problems } = parse({ ALLOWED_GITHUB_ORG: " my-org " });

    expect(problems).toEqual([]);
    expect(config.org).toBe("my-org");
    expect(isAccessConfigured(config)).toBe(true);
    expect(isLoginListed(config, "octocat")).toBe(false);
  });

  it.each([
    "my org",
    "my/org",
    "../orgs/other",
    "-leading-hyphen",
    "org?x=1",
    "a".repeat(40),
    "org,other",
    "double--hyphen",
    "trailing-",
  ])("is refused as a configuration problem when it is %j", (org) => {
    const { problems } = parse({ ALLOWED_GITHUB_ORG: org });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ALLOWED_GITHUB_ORG");
    expect(problems[0]).not.toContain(org);
  });
});

describe("entries of ALLOWED_GITHUB_LOGINS that cannot be logins", () => {
  it("are reported, still match nothing, and do not touch the valid entries", () => {
    const { config } = parse({
      ALLOWED_GITHUB_LOGINS: "octocat, @hubot ,octo/cat,two words,ok-name",
    });

    expect(config.invalidLoginEntries).toEqual([
      "@hubot",
      "octo/cat",
      "two words",
    ]);
    expect(isLoginListed(config, "octocat")).toBe(true);
    expect(isLoginListed(config, "ok-name")).toBe(true);
    expect(isLoginListed(config, "hubot")).toBe(false);
  });

  it("are not reported for a clean list", () => {
    expect(
      parse({ ALLOWED_GITHUB_LOGINS: "octocat,Hubot-2,a--b" }).config
        .invalidLoginEntries,
    ).toEqual([]);
  });
});

describe("both variables set", () => {
  // CR-19-T12
  it("admits a listed login and also keeps the organization check, never everybody", () => {
    const { config, problems } = parse({
      ALLOWED_GITHUB_LOGINS: "octocat",
      ALLOWED_GITHUB_ORG: "my-org",
    });

    expect(problems).toEqual([]);
    expect(isAccessConfigured(config)).toBe(true);
    expect(isLoginListed(config, "octocat")).toBe(true);
    expect(isLoginListed(config, "mallory")).toBe(false);
    expect(config.org).toBe("my-org");
  });
});

describe("entries of the form login:id in ALLOWED_GITHUB_LOGINS", () => {
  // CR-42-T07
  it("list the login and pre-set the GitHub id it is bound to, next to plain entries", () => {
    const { config, problems } = parse({
      ALLOWED_GITHUB_LOGINS: "octocat:1001,hubot",
    });

    expect(problems).toEqual([]);
    expect(isLoginListed(config, "octocat")).toBe(true);
    expect(isLoginListed(config, "hubot")).toBe(true);
    expect([...config.presetIds]).toEqual([["octocat", "1001"]]);
    expect(config.invalidLoginEntries).toEqual([]);
    expect(config.invalidPresetEntries).toBe(0);
  });

  // CR-42-T09
  it.each([
    ["OctoCat:1001", "octocat", "1001"],
    ["  octocat:1001  ", "octocat", "1001"],
    ["octocat:9", "octocat", "9"],
    ["octocat:12345678901234567890", "octocat", "12345678901234567890"],
  ])("accept %j", (entry, login, id) => {
    const { config } = parse({ ALLOWED_GITHUB_LOGINS: `hubot,${entry}` });

    expect(config.invalidPresetEntries).toBe(0);
    expect(config.presetIds.get(login)).toBe(id);
    expect(isLoginListed(config, login)).toBe(true);
  });

  // CR-42-T09
  it.each([
    "octocat:",
    ":1001",
    "octocat:abc",
    "octocat:10:20",
    "octocat:-5",
    "octocat:0",
    "octocat:01001",
    "octocat:+5",
    "octocat:1.5",
    "octocat: 1001",
    "octocat :1001",
    "octocat:123456789012345678901",
    "@octocat:1001",
    "two words:1001",
  ])(
    "ignore the invalid entry %j, count it, and admit nobody through it",
    (entry) => {
      const { config, problems } = parse({
        ALLOWED_GITHUB_LOGINS: `hubot,${entry}`,
      });

      expect(problems).toEqual([]);
      expect(config.invalidPresetEntries).toBe(1);
      expect(config.presetIds.size).toBe(0);
      expect(isLoginListed(config, "hubot")).toBe(true);
      expect(isLoginListed(config, entry.split(":")[0] ?? "")).toBe(false);
      expect([...config.logins]).toEqual(["hubot"]);
    },
  );

  it("do not count as plain entries that cannot be logins", () => {
    const { config } = parse({ ALLOWED_GITHUB_LOGINS: "octocat:abc,@hubot" });

    expect(config.invalidLoginEntries).toEqual(["@hubot"]);
    expect(config.invalidPresetEntries).toBe(1);
  });

  it("take no entry at all for a login that is given two different ids", () => {
    const { config } = parse({
      ALLOWED_GITHUB_LOGINS: "octocat:1001,OctoCat:2002,octocat,hubot",
    });

    expect(config.invalidPresetEntries).toBe(2);
    expect(isLoginListed(config, "octocat")).toBe(false);
    expect(config.presetIds.size).toBe(0);
    expect(isLoginListed(config, "hubot")).toBe(true);
  });

  it("count a contradiction the same way whatever the order of the entries", () => {
    const entries = ["octocat:1001", "OctoCat:2002", "octocat:1001"];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];

    for (const order of orders) {
      const { config } = parse({
        ALLOWED_GITHUB_LOGINS: order.map((i) => entries[i]).join(","),
      });

      expect(config.invalidPresetEntries).toBe(3);
      expect(config.presetIds.size).toBe(0);
      expect(isLoginListed(config, "octocat")).toBe(false);
    }
  });

  it("accept the same id given twice", () => {
    const { config } = parse({
      ALLOWED_GITHUB_LOGINS: "octocat:1001,OctoCat:1001",
    });

    expect(config.invalidPresetEntries).toBe(0);
    expect([...config.presetIds]).toEqual([["octocat", "1001"]]);
  });
});
