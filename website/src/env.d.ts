// SPDX-License-Identifier: LicenseRef-Proprietary

interface ImportMetaEnv {
  /** PostHog-Projektschlüssel (Hauptprojekt). Beim Build eingebettet; ohne ihn kein Tracking und kein Banner. */
  readonly PUBLIC_POSTHOG_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
