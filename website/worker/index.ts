// SPDX-License-Identifier: LicenseRef-Proprietary

// Läuft nur für die Pfade aus `assets.run_worker_first` in wrangler.jsonc.
import { handleIngest } from "./ingest";

export default {
  async fetch(request, _env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/ingest" || pathname.startsWith("/ingest/")) return handleIngest(request, ctx);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler;
