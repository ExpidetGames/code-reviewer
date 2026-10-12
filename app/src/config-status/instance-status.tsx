// SPDX-License-Identifier: Apache-2.0

// The "Instance" block on the Settings page: whether the GitHub App and the LLM access work, in
// plain words. For the instance admin: variable names where something is wrong, provider and model where
// it works, never a value (src/config-status/status.ts). For a member of a workspace only whether each part
// is set up.
import type { ConfigAudience, ConfigStatus } from "./status.ts";

export function InstanceStatus({
  status,
  audience = "member",
}: {
  status: ConfigStatus;
  audience?: ConfigAudience;
}) {
  const { githubApp, llm } = status;
  if (audience === "member")
    return (
      <dl className="status-list">
        <div>
          <dt>GitHub</dt>
          <dd>
            {githubApp.configured
              ? "Set up"
              : "Not set up yet. Ask your instance admin."}
          </dd>
        </div>
        <div>
          <dt>Reviews</dt>
          <dd>
            {llm.configured
              ? "Set up"
              : "Not set up yet. Ask your instance admin."}
          </dd>
        </div>
      </dl>
    );
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
              {githubApp.variables.length === 0 ? (
                "Not connected"
              ) : (
                <>
                  {githubApp.kind === "missing" ? "Missing" : "Not valid"}:{" "}
                  <span className="mono">{githubApp.variables.join(", ")}</span>
                </>
              )}
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
