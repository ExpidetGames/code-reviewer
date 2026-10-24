# SPDX-License-Identifier: LicenseRef-Proprietary
# Experimental layer only; the binary is downloaded/checksummed before the offline test.
ARG RUNNER_IMAGE=code-reviewer-runner:compose
FROM ${RUNNER_IMAGE}
USER root
RUN apt-get update && apt-get install --yes --no-install-recommends bubblewrap git ripgrep python3 && rm -rf /var/lib/apt/lists/*
COPY opencode /usr/local/bin/opencode
COPY probe.py test_probe.py /spike/
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "-m", "unittest", "discover", "-s", "/spike", "-p", "test_probe.py"]
