// SPDX-License-Identifier: Apache-2.0

// The installation page of the fake GitHub: what a person sees at `github.com/apps/<slug>/installations/new`
// and where it sends them. The real page lets the person choose an account and the repositories and press
// "Install" (or, for an organization they do not own, ask the owners to approve). The fake offers one pair of
// buttons per installation it holds (a test adds the installation first, which stands for the account the
// person chooses):
//
//   "Install on <account>"   sends the browser to the app's setup URL with `installation_id`,
//                            `setup_action=install` and the `state` the page was opened with
//   "Ask <account> to approve" the same with `setup_action=request` and no installation id, as GitHub does
//                            when the person cannot install it themselves
//
// The setup URL comes from the app (the manifest names it; for the app registered at start a test says it).
// State is in memory. Dummy values only.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readForm, redirect, sendHtml } from "./http.ts";
import type { AppRegistry } from "./registry.ts";
import type { FakeInstallation } from "./app-api.ts";

export type InstallPart = {
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean>;
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
}

export function createInstallPart(
  registry: AppRegistry,
  installations: () => FakeInstallation[],
): InstallPart {
  const appBySlug = (slug: string) =>
    registry.all().find((app) => app.slug === slug);

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const method = request.method ?? "GET";
    const page = /^\/apps\/([^/]+)\/installations\/new$/.exec(url.pathname);
    if (method === "GET" && page) {
      const app = appBySlug(decodeURIComponent(page[1] ?? ""));
      if (app === undefined) {
        sendHtml(response, 404, "<h1>Not Found</h1>");
        return true;
      }
      const state = url.searchParams.get("state") ?? "";
      const hidden =
        `<input type="hidden" name="slug" value="${escapeHtml(app.slug)}">` +
        `<input type="hidden" name="state" value="${escapeHtml(state)}">`;
      const choices = installations()
        .map(
          (installation) =>
            `<form method="post" action="/apps/${encodeURIComponent(app.slug)}/installations/confirm">${hidden}` +
            `<input type="hidden" name="installation_id" value="${String(installation.id)}">` +
            `<button type="submit" name="action" value="install">Install on ${escapeHtml(installation.account.login)}</button>` +
            `<button type="submit" name="action" value="request">Ask ${escapeHtml(installation.account.login)} to approve</button></form>`,
        )
        .join("");
      sendHtml(
        response,
        200,
        `<h1>Install ${escapeHtml(app.name)}</h1><p>This is a fake GitHub for tests.</p>${choices}`,
      );
      return true;
    }

    const confirm = /^\/apps\/([^/]+)\/installations\/confirm$/.exec(
      url.pathname,
    );
    if (method === "POST" && confirm) {
      const form = await readForm(request);
      const app = appBySlug(decodeURIComponent(confirm[1] ?? ""));
      if (app === undefined || app.setupUrl === null) {
        sendHtml(
          response,
          400,
          "<h1>Bad request</h1><p>The app has no setup URL.</p>",
        );
        return true;
      }
      const target = new URL(app.setupUrl);
      const action = form.get("action") === "request" ? "request" : "install";
      // Like GitHub, a request for approval carries no installation id: there is no installation yet.
      if (action === "install")
        target.searchParams.set(
          "installation_id",
          form.get("installation_id") ?? "",
        );
      target.searchParams.set("setup_action", action);
      const state = form.get("state");
      if (state) target.searchParams.set("state", state);
      redirect(response, target);
      return true;
    }
    return false;
  }

  return { handle };
}
