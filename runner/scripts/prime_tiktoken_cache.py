# SPDX-License-Identifier: Apache-2.0

"""Downloads the tiktoken encoding PR-Agent counts tokens with into tiktoken's cache directory.

The engine suite runs without any outside connection, so the encoding has to be cached before it
starts (the runner image does the same at build time). This is the one step that needs the internet;
run it once per machine and per cache directory, and in CI before the engine tests:

    uv run python scripts/prime_tiktoken_cache.py

The cache directory is TIKTOKEN_CACHE_DIR or DATA_GYM_CACHE_DIR if set, else the system temporary
directory (`data-gym-cache`), which is where the engine suite looks. Nothing is downloaded when the
encoding is cached already. A failed download is tried three times, because the blob host is the
only network dependency of the engine job.
"""

import sys
import time

import tiktoken

ATTEMPTS = 3


def main() -> int:
    for attempt in range(1, ATTEMPTS + 1):
        try:
            tiktoken.get_encoding("o200k_base")
        except Exception as error:  # a network error of any library tiktoken uses
            sys.stderr.write(f"attempt {attempt} of {ATTEMPTS} failed: {type(error).__name__}\n")
            if attempt == ATTEMPTS:
                return 1
            time.sleep(2**attempt)
        else:
            sys.stdout.write("o200k_base is cached\n")
            return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
