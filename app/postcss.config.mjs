// SPDX-License-Identifier: Apache-2.0

// Tailwind CSS v4 for the app (Next.js 16). The plugin is the whole configuration: Tailwind v4 is
// configured in CSS (src/app/theme.css), not in a JS config file. See
// node_modules/next/dist/docs/01-app/01-getting-started/11-css.md.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
