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
  ])("is refused as a configuration problem when it is %j", (org) => {
    const { problems } = parse({ ALLOWED_GITHUB_ORG: org });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ALLOWED_GITHUB_ORG");
    expect(problems[0]).not.toContain(org);
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
