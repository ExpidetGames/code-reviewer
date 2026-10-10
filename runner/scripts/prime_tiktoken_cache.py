"""Downloads the tiktoken encoding PR-Agent counts tokens with into tiktoken's cache directory.

The engine suite runs without any outside connection, so the encoding has to be cached before it
starts (the runner image does the same at build time). This is the one step that needs the internet;
run it once per machine and per cache directory, and in CI before the engine tests:

    uv run python scripts/prime_tiktoken_cache.py

The cache directory is DATA_GYM_CACHE_DIR or TIKTOKEN_CACHE_DIR if set, else the system temporary
directory (`data-gym-cache`), which is where the engine suite looks.
"""

import sys

import tiktoken


def main() -> int:
    tiktoken.get_encoding("o200k_base")
    sys.stdout.write("o200k_base is cached\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
