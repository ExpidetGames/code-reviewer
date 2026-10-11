// Whether anybody has started to configure the GitHub App. No `GITHUB_APP_*` variable at all is the
// normal state of an instance that is not connected to GitHub (yet): "not configured", not an error,
// so nothing is logged about it and nothing is attempted. A partial or unusable set is a different
// matter (config.ts reports it).
type Env = Readonly<Record<string, string | undefined>>;

export const GITHUB_APP_VARIABLES = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_PATH",
] as const;

export function anyGithubAppVariableSet(env: Env): boolean {
  return GITHUB_APP_VARIABLES.some((name) => (env[name] ?? "").trim() !== "");
}
