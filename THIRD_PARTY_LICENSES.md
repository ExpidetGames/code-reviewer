# Third party licenses

code-review.com is licensed under the Apache License, Version 2.0 (see `LICENSE` and `NOTICE`).
This file lists the third party software that the project depends on, the license notices that
those licenses require us to keep, and the result of the last license review of the dependencies.

None of this software is copied into the repository, except the shadcn/ui components (see that
section): they are copied under `app/src/components/ui/` and keep their MIT header and notice. The
app installs its packages with pnpm and the runner installs its packages with uv, both from the
lockfiles, and both container images are built from the same lockfiles.

Both container images (app and runner) carry `LICENSE`, `NOTICE` and this file in `/licenses`; the
image smoke tests check that they are there and identical to the files of the repository.

## PR-Agent

- Package: pr-agent 0.47.0 (pinned in `runner/pyproject.toml`)
- Source: https://github.com/qodo-ai/pr-agent
- License: MIT, compatible with distributing it as part of an Apache-2.0 project. The MIT
  license only asks that the copyright notice and the permission text are preserved, which is done
  below.

```text
MIT License

Copyright (c) 2026 The PR Agent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

When the pinned version changes, check that the license text and the copyright line above still
match the license shipped in the new release.

## shadcn/ui

- Source: https://github.com/shadcn-ui/ui, https://ui.shadcn.com
- License: MIT. Unlike the dependencies above, shadcn/ui components are **copied into the
  repository** under `app/src/components/ui/` (that is how shadcn/ui is used), so the MIT notice
  must travel with them. Each copied file keeps a `// SPDX-License-Identifier: MIT` header with a
  provenance line; every other source file stays Apache-2.0 (`app/src/ci/spdx-headers/rules.ts`).
- Components copied so far (27, all under `app/src/components/ui/`): `alert`, `alert-dialog`,
  `avatar`, `badge`, `breadcrumb`, `button`, `card`, `checkbox`, `collapsible`, `dialog`,
  `dropdown-menu`, `empty`, `field`, `input`, `label`, `progress`, `radio-group`, `select`,
  `separator`, `sheet`, `sidebar`, `skeleton`, `switch`, `table`, `tabs`, `textarea`, `tooltip`.
  They use the Radix UI primitives through the unified `radix-ui` package (the primitive set the
  current shadcn registry ships for Tailwind v4), which is a normal dependency and MIT-licensed.
- A few of the copies carry a small local adaptation; a re-copy has to re-apply it (the file keeps
  the MIT header and the provenance line): the application `button`, `badge` and `alert` add this
  project's variants and the button a native-control reset (Tailwind's preflight reset is only
  enabled with the legacy-CSS cleanup, #185); the `dialog`, `alert-dialog` and `sheet` overlays use
  the `--overlay` token instead of `bg-black`; `progress` passes `value` to the Radix root so it
  exposes `aria-valuenow`; `sidebar`'s `SidebarMenuSkeleton` derives a stable width from `useId`
  (the React compiler rejects `Math.random` during render).
- `app/src/lib/utils.ts` (`cn`) and `app/src/hooks/use-mobile.ts` (`useIsMobile`) follow shadcn/ui's
  helpers but are short compositions of our own that stay Apache-2.0; they are not copied
  components.

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The Tailwind CSS v4 packages the app installs (`tailwindcss`, `@tailwindcss/postcss`) and the
shadcn runtime dependencies (`clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`,
`tw-animate-css`, `radix-ui`) are MIT/Apache-2.0/ISC and need no exception.

## Dependency license review

Last review: 2026-10-12, against `app/pnpm-lock.yaml` (pnpm 10) and `runner/uv.lock` (pr-agent 0.47.0).
The licenses were read from the package metadata that pnpm and uv install.

A scan runs in CI (the job "Licenses: dependency check", locally `make check-licenses`; it is part of
`make verify`). It fails when a dependency of either lockfile carries a license that is not on the
allow list below and not granted to that package by name. The allow list and every exception below
are kept in [`license-policy.json`](license-policy.json), which the scan reads; a test
(`app/src/ci/license-check/policy-doc.test.ts`) fails when this section and that file disagree. To
allow a new license or a new exception, change both.

### Allowed licenses

Permissive licenses, compatible with distributing this project under Apache-2.0. A dependency
whose license expression is satisfied by these needs no entry anywhere:
`0BSD`, `Apache-2.0`, `BlueOak-1.0.0`, `BSD-2-Clause`, `BSD-3-Clause`, `CC0-1.0`, `CNRI-Python`,
`ISC`, `MIT`, `MIT-0`, `PSF-2.0`, `Python-2.0`, `TCL`.

"A OR B" is allowed when one side is allowed, "A AND B" when both are. Python packages that only
name a license in free text or in a trove classifier are read by `python-license.ts` in the same
folder; the spelling it does not know fails the scan until it is added there.

### App (`app/`)

#### Exceptions

| Package | License | Note |
|---|---|---|
| `@img/sharp-*` | LGPL-3.0-or-later | All `@img/sharp-libvips-*` packages and the prebuilt `@img/sharp-*` binaries for every platform (including win32 and the wasm builds): prebuilt libvips, optional dependencies of `sharp`, which Next.js uses for image optimization. Used unmodified and dynamically loaded as a separate binary, not linked into our code |
| `axe-core` | MPL-2.0 | Test tooling only. File level copyleft, used unmodified, nothing of it is part of our source |
| `lightningcss` | MPL-2.0 | A build tool of Next.js. Used unmodified as a tool |
| `lightningcss-*` | MPL-2.0 | The platform binaries of `lightningcss`. Used unmodified as tools |
| `caniuse-lite` | CC-BY-4.0 | Browser support data used by the build tooling. Data, not code. Attribution: Alexis Deveria and contributors, https://github.com/browserslist/caniuse-lite |

#### Not installed on every platform

The lockfile lists the binaries for every operating system, but only the ones for the machine that
runs `pnpm install` are installed, so their metadata cannot be read everywhere. The licenses below
were read from the npm registry when the entries were added and are judged like any other license.

| Package | License | Note |
|---|---|---|
| `@emnapi/*` | MIT | WebAssembly fallback of native packages |
| `@img/sharp-*` | Apache-2.0 AND LGPL-3.0-or-later AND MIT | sharp and libvips binaries for other platforms, the strictest declaration of any of them |
| `@napi-rs/wasm-runtime` | MIT | WebAssembly fallback of native packages |
| `@next/swc-*` | MIT | Next.js compiler binaries for other platforms |
| `@rolldown/binding-*` | MIT | Rolldown binaries for other platforms |
| `@tailwindcss/oxide-*` | MIT | Tailwind CSS Oxide engine binaries for other platforms; only the one for the current platform is installed |
| `@tybys/wasm-util` | MIT | WebAssembly fallback of native packages |
| `@unrs/resolver-binding-*` | MIT | Resolver binaries for other platforms |
| `fsevents` | MIT | File watching on macOS only, an optional dependency of watchers |
| `lightningcss-*` | MPL-2.0 | lightningcss binaries for other platforms |

No package of the app uses a license that conflicts with distributing this project under Apache-2.0.

### Runner (`runner/`)

The runner installs PR-Agent and everything PR-Agent depends on (about 150 packages), plus the
development tools of the runner. Nearly all are MIT, BSD, Apache-2.0, ISC or PSF licensed. These are
the exceptions:

#### Exceptions

| Package | License | Note |
|---|---|---|
| `html2text` | GPL-3.0-only | Version 2024.2.26. Required by PR-Agent and imported by it at runtime |
| `python-gitlab` | LGPL-3.0-or-later | Version 8.3.0. Required by PR-Agent, used unmodified as a library |
| `PyGithub` | LicenseRef-LGPL | Version 2.10.0, LGPL-3.0 upstream. Its metadata only carries the generic LGPL classifier, which the scan reads as `LicenseRef-LGPL`. Required by PR-Agent, used unmodified as a library |
| `certifi` | MPL-2.0 | Used unmodified |
| `tqdm` | MPL-2.0 | Declared as MPL-2.0 AND MIT. Used unmodified |
| `giteapy` | NONE | Version 1.0.8. No license declared in the package metadata. Required by PR-Agent, never used by our runner |

#### Not installed on every platform

`uv.lock` also lists packages that are only installed under a platform marker.

| Package | License | Note |
|---|---|---|
| `colorama` | BSD-3-Clause | Windows only |
| `httpx2-jsfetch` | BSD-3-Clause | Pyodide (emscripten) only |
| `win32-setctime` | MIT | Windows only |

Our own source code stays under Apache-2.0: Apache-2.0 is compatible with the GPL-3.0 in one
direction, and we do not copy or modify any of these packages.

`html2text` 2024.2.26 (GPL-3.0, https://github.com/Alir3z4/html2text) is installed unmodified from
PyPI into the runner image. It is pure Python (a `py3-none-any` wheel), so its complete source code
is included in the image as installed, in `/opt/venv/lib/python3.13/site-packages/html2text/`. The
GPL-3.0 text is in the same environment, in
`/opt/venv/lib/python3.13/site-packages/html2text-2024.2.26.dist-info/licenses/COPYING`. Because the
source travels with the image, no separate written offer is needed. If the version changes, update
the version and the paths here.

## Updating this file

The scan catches a new license by itself. When it fails, decide whether the license is acceptable
for a project under Apache-2.0 (permissive ones are; copyleft ones need a reason and usually a
different dependency). If it is acceptable, add it to `license-policy.json` and to the matching
table or list here, with a note, and update the date above. Run the full review again when
dependencies change in a way that adds many packages (a new direct dependency, a PR-Agent upgrade).
