// SPDX-License-Identifier: Apache-2.0

// Services for "the workspace the signed-in user works in" (see current-workspace.ts), handed out
// without waiting: the workspace is looked up when the first method is called, not when the service is
// asked for. That keeps the order the routes promise ("`requireUser()` first, before any data is
// read"): a route builds its service while it wires its handler, and the handler calls `requireUser()`
// before it uses the service, so an anonymous request never reaches the database.
import "server-only";
import { getCurrentWorkspaceId } from "./current-workspace.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a service is a bag of async methods of any signature.
type AsyncMethods = { [name: string]: (...args: any[]) => Promise<unknown> };

/**
 * A service whose every method runs in the current workspace. `build` makes the real service for a
 * workspace id; it is called once per returned service.
 */
export function inCurrentWorkspace<T extends AsyncMethods>(
  build: (workspaceId: string) => T,
  resolveWorkspaceId: () => Promise<string> = getCurrentWorkspaceId,
): T {
  let pending: Promise<T> | undefined;
  const service = () => (pending ??= resolveWorkspaceId().then(build));

  return new Proxy({} as T, {
    get(_target, property) {
      // Not a method name: `then` must stay undefined or the proxy would look like a promise.
      if (typeof property !== "string" || property === "then") return undefined;
      return async (...args: unknown[]) => {
        const target = await service();
        const method: unknown = target[property];
        if (typeof method !== "function")
          throw new TypeError(`The service has no method "${property}".`);
        return method.apply(target, args);
      };
    },
  });
}
