// SPDX-License-Identifier: Apache-2.0

import type { NextConfig } from "next";
import {
  MISSING_PATH,
  PORTAL_API_ROOT,
  PORTAL_DENIED_HEADER,
  PORTAL_PAGE_ROOT,
  PORTAL_REWRITE_HEADER,
  PROXY_SKIPPED_PATHS,
} from "./src/admin/paths.ts";

const nextConfig: NextConfig = {
  // A self-contained server (`.next/standalone/server.js`) with only the files it needs, for the
  // Docker image (app/Dockerfile).
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
    return [
      {
        // The address of these pages can carry an invitation link (its token is the credential), so a
        // browser must not pass it on as a referrer to anything the page loads or links to
        // (src/workspaces/README.md). The pages ask for the same in their metadata.
        source: "/:path(invitation|login|sign-up)",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
  async rewrites() {
    return {
      // A request for the files of the admin portal by their own address is marked by the proxy
      // (src/admin/paths.ts). Next.js answers it as a path that does not exist, the same as any other,
      // with nothing of the portal in the answer.
      beforeFiles: [
        // The instance admin's request for the portal (`/admin`, `/api/admin`) is marked by the proxy and
        // served from the files of the portal. Not a rewrite made by the proxy: see PORTAL_REWRITE_HEADER.
        // Nobody else carries the header (the proxy takes it off), and the pages and routes of the portal
        // check the admin again themselves.
        {
          source: "/admin/:path*",
          has: [{ type: "header", key: PORTAL_REWRITE_HEADER }],
          destination: `${PORTAL_PAGE_ROOT}/:path*`,
        },
        {
          source: "/api/admin/:path*",
          has: [{ type: "header", key: PORTAL_REWRITE_HEADER }],
          destination: `${PORTAL_API_ROOT}/:path*`,
        },
        {
          // Only what the proxy sees: it is the proxy that takes the header off a request from outside.
          source: `/:path((?!${PROXY_SKIPPED_PATHS}).*)`,
          has: [{ type: "header", key: PORTAL_DENIED_HEADER }],
          destination: MISSING_PATH,
        },
      ],
      afterFiles: [],
      // Every path that is no route gets to the same place, so the answer of a marked request and the
      // answer of a path that was never there are made the same way. On an RSC request Next.js adds
      // `x-nextjs-rewritten-path` to the answer of any rewrite; if only the marked request were rewritten,
      // that header would tell it from a missing path. (Next.js's own files keep their own answer.)
      fallback: [{ source: "/:path((?!_next/).*)", destination: MISSING_PATH }],
    };
  },
};

export default nextConfig;
