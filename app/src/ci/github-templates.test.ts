// Pins down the issue forms and the pull request template: GitHub only shows a form that parses
// and has the keys it needs, the forms must apply the labels the project board relies on, and the
// bug form must remind people to remove secrets from logs and must never ask for a credential.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const templateDir = `${repoRoot}.github/ISSUE_TEMPLATE/`;

type FormElement = {
  type: "markdown" | "input" | "textarea" | "dropdown" | "checkboxes";
  id?: string;
  attributes: {
    label?: string;
    render?: string;
    description?: string;
    value?: string;
    options?: unknown[];
  };
  validations?: { required?: boolean };
};

type IssueForm = {
  name: string;
  description: string;
  title?: string;
  labels?: string[];
  body: FormElement[];
};

function form(file: string): IssueForm {
  return parse(readFileSync(`${templateDir}${file}`, "utf8")) as IssueForm;
}

function field(issueForm: IssueForm, id: string): FormElement {
  const element = issueForm.body.find((entry) => entry.id === id);
  if (!element) throw new Error(`no field ${id}`);
  return element;
}

describe("issue form files", () => {
  it("has exactly the bug, feature and question forms and the config", () => {
    expect(readdirSync(templateDir).sort()).toEqual([
      "bug_report.yml",
      "config.yml",
      "feature_request.yml",
      "question.yml",
    ]);
  });

  it.each(["bug_report.yml", "feature_request.yml", "question.yml"])(
    "%s has a name, a description and a body with unique ids",
    (file) => {
      const issueForm = form(file);
      const ids = issueForm.body.flatMap((entry) =>
        entry.id ? [entry.id] : [],
      );

      expect(issueForm.name).toBeTruthy();
      expect(issueForm.description).toBeTruthy();
      expect(issueForm.body.length).toBeGreaterThan(1);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it("labels a bug report with type: bug", () => {
    expect(form("bug_report.yml").labels).toEqual(["type: bug"]);
  });

  it("labels a feature request with type: feature", () => {
    expect(form("feature_request.yml").labels).toEqual(["type: feature"]);
  });

  it("labels a question with question", () => {
    expect(form("question.yml").labels).toEqual(["question"]);
  });
});

describe("bug report form", () => {
  const bug = form("bug_report.yml");

  it("requires the version, the deployment type, the steps, the expected and the actual behavior", () => {
    for (const id of ["version", "deployment", "steps", "expected", "actual"]) {
      expect(field(bug, id).validations?.required, id).toBe(true);
    }
  });

  it("offers the ways to run the project as deployment types", () => {
    const options = JSON.stringify(field(bug, "deployment").attributes.options);

    expect(options).toContain("Docker Compose");
    expect(options).toContain("Coolify");
    expect(options).toContain("Local development");
  });

  it("asks for logs only after redaction and renders them as text", () => {
    const logs = field(bug, "logs");

    expect(logs.attributes.description).toMatch(/remove|redact/i);
    expect(logs.attributes.description).toMatch(/API keys?/);
    expect(logs.attributes.description).toMatch(/tokens?/);
    expect(logs.validations?.required).not.toBe(true);
    expect(logs.attributes.render).toBe("text");
  });

  it("makes people confirm that they removed secrets before submitting", () => {
    const checks = bug.body.find((entry) => entry.type === "checkboxes");

    expect(JSON.stringify(checks?.attributes.options)).toMatch(/secrets/i);
    expect(JSON.stringify(checks?.attributes.options)).toContain(
      '"required":true',
    );
  });

  it("does not ask for a credential in any field label", () => {
    const labels = bug.body
      .map((entry) => entry.attributes.label ?? "")
      .join("\n")
      .toLowerCase();

    expect(labels).not.toMatch(/api key|token|secret|password|private key/);
  });
});

describe("feature request form", () => {
  it("requires the problem to be solved", () => {
    expect(
      field(form("feature_request.yml"), "problem").validations?.required,
    ).toBe(true);
  });
});

describe("issue template config", () => {
  const config = parse(readFileSync(`${templateDir}config.yml`, "utf8")) as {
    blank_issues_enabled: boolean;
    contact_links: { name: string; url: string; about: string }[];
  };

  it("disables blank issues so that every report uses a form", () => {
    expect(config.blank_issues_enabled).toBe(false);
  });

  it("adds no security link of its own, because GitHub shows one for private vulnerability reporting", () => {
    const urls = config.contact_links.map((link) => link.url);
    const names = config.contact_links.map((link) => link.name);

    expect(urls.join(" ")).not.toContain("/security/advisories");
    expect(names.join(" ")).not.toMatch(/security|vulnerabilit/i);
  });

  it("keeps the documentation link as the only contact link", () => {
    expect(config.contact_links.map((link) => link.name)).toEqual([
      "Documentation",
    ]);
  });

  it("keeps the pointer to the private advisory form at the top of the bug form", () => {
    const [intro] = form("bug_report.yml").body;

    expect(intro?.type).toBe("markdown");
    expect(intro?.attributes.value).toContain(
      "https://github.com/ExpidetGames/code-reviewer/security/advisories/new",
    );
  });

  it("does not link to GitHub Discussions while the repository has them switched off", () => {
    expect(JSON.stringify(config)).not.toContain("/discussions");
  });
});

describe("pull request template", () => {
  const template = readFileSync(
    `${repoRoot}.github/pull_request_template.md`,
    "utf8",
  );

  it("asks for the linked issue with Closes", () => {
    expect(template).toContain("Closes #");
  });

  it("has sections for the summary, the testing and follow-ups", () => {
    expect(template).toMatch(/## Summary/);
    expect(template).toMatch(/## How it was tested/);
    expect(template).toMatch(/## Follow-ups/);
  });

  it("has an optional test cases section with a case, test and status table", () => {
    expect(template).toMatch(/## Test cases/);
    expect(template).toMatch(/Optional for contributors/);
    expect(template).toContain("| Test case | Test file / name | Status |");
  });

  it("has a checklist for tests first, make verify, documentation and no secrets", () => {
    expect(template).toMatch(/- \[ \] .*test.*first/i);
    expect(template).toContain("make verify");
    expect(template).toMatch(/- \[ \] .*documentation/i);
    expect(template).toMatch(/- \[ \] .*no secrets/i);
  });

  it("contains no em dash", () => {
    expect(template).not.toContain("—");
  });
});
