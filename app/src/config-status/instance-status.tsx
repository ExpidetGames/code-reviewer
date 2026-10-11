// SPDX-License-Identifier: Apache-2.0

// The "Instance" block on the Settings page: whether the GitHub App and the LLM access work, in
// plain words. Variable names where something is wrong, provider and model where it works, never a
// value (src/config-status/status.ts).
import type { ConfigStatus } from "./status.ts";

export function InstanceStatus({ status }: { status: ConfigStatus }) {
  const { githubApp, llm } = status;
  return (
    <dl className="status-list">
      <div>
        <dt>GitHub App</dt>
        <dd>
          {githubApp.configured ? (
            <>
              Configured (<span className="mono">{githubApp.slug}</span>)
            </>
          ) : (
            <>
              {githubApp.kind === "missing" ? "Missing" : "Not valid"}:{" "}
              <span className="mono">{githubApp.variables.join(", ")}</span>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>LLM access</dt>
        <dd>
          {llm.configured ? (
            <>
              Configured: <span className="mono">{llm.provider}</span>, default
              model <span className="mono">{llm.model}</span>
            </>
          ) : (
            <>
              Not configured:{" "}
              <span className="mono">
                {[...new Set(llm.issues.map((issue) => issue.variable))].join(
                  ", ",
                )}
              </span>
            </>
          )}
        </dd>
      </div>
    </dl>
  );
}
