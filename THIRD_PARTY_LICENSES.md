# Third party licenses

code-review.com is licensed under the Apache License, Version 2.0 (see `LICENSE` and `NOTICE`).
This file lists the third party software that the project depends on, the license notices that
those licenses require us to keep, and the result of the last license review of the dependencies.

None of this software is copied into the repository. The app installs its packages with pnpm and
the runner installs its packages with uv, both from the lockfiles, and both container images are
built from the same lockfiles.

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

## Dependency license review

Last review: 2026-10-11, against `app/pnpm-lock.yaml` (pnpm 10) and `runner/uv.lock` (pr-agent 0.47.0).
The licenses were read from the package metadata that pnpm and uv install. A scan in CI is not set up
yet.

### App (`app/`)

The dependency tree of the app (production and development) uses these licenses:

| License | Packages | Note |
|---|---|---|
| MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0, CC0-1.0, Apache-2.0 | the large majority | Permissive, compatible with Apache-2.0 |
| MPL-2.0 | `lightningcss` (a build tool of Next.js), `axe-core` (test tooling only) | File level copyleft. Used unmodified as tools, nothing of them is part of our source |
| LGPL-3.0-or-later | `@img/sharp-libvips-*` (prebuilt binary of libvips, an optional dependency of `sharp`, which Next.js uses for image optimization) | Used unmodified and dynamically loaded as a separate binary, not linked into our code |
| CC-BY-4.0 | `caniuse-lite` (browser support data used by the build tooling) | Data, not code. Attribution: Alexis Deveria and contributors, https://github.com/browserslist/caniuse-lite |

No package of the app uses a license that conflicts with distributing this project under Apache-2.0.

### Runner (`runner/`)

The runner installs PR-Agent and everything PR-Agent depends on (about 150 packages). Nearly all
are MIT, BSD, Apache-2.0, ISC or PSF licensed. These are the exceptions:

| Package | License | Note |
|---|---|---|
| `html2text` 2024.2.26 | GPL-3.0 | Required by PR-Agent and imported by it at runtime |
| `python-gitlab` 8.3.0 | LGPL-3.0 | Required by PR-Agent, used unmodified as a library |
| `PyGithub` 2.10.0 | LGPL-3.0 | Required by PR-Agent, used unmodified as a library |
| `certifi`, `tqdm` (partly) | MPL-2.0 | Used unmodified |
| `giteapy` 1.0.8 | none declared in the package metadata | Required by PR-Agent, never used by our runner |

Our own source code stays under Apache-2.0: Apache-2.0 is compatible with the GPL-3.0 in one
direction, and we do not copy or modify any of these packages. Anyone who redistributes a built
runner image that contains `html2text` has to meet the terms of the GPL-3.0 for that package
(the corresponding source is the unmodified release on PyPI, linked above). Whether this needs more
than a note here, for example a source offer next to the published images, is an open question for
the maintainers.

## Updating this file

Run the review again when dependencies change in a way that adds new packages (a new direct
dependency, a PR-Agent upgrade) and update the date and the tables.
