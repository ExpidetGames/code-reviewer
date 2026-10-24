# SPDX-License-Identifier: LicenseRef-Proprietary

"""Where the key of a native job may be sent (#578, #555). Needs a security review.

The key goes to one address: the one the entry of the claim names, if the runner can accept it
for the provider the key belongs to.

- **A provider of the registry** (`anthropic`, `openrouter`) has its own API address in the
  registry; the entry must name exactly that (a trailing slash aside). The catalog is not asked.
- **Any other provider of the models.dev catalog** has no address the runner knows. The app sends
  the address its catalog trusts for the provider (#548: https, a public host, the first safe
  address seen, a change blocks the provider until an admin confirms it) and never one the
  workspace typed or the catalog states but does not trust. The runner cannot see that trust
  record, so it judges what it can: the entry is of the provider the key is for (the id of the
  entry is the slug with hyphens); the address is a plain public https address (`check_base_url`:
  port 443 only, no credentials, no query, a public name or address, a plain path) **in exactly
  that spelling** (the app writes it in its canonical form, so the string the app judged is the
  string the supervisor connects to, with no normalisation in between); and the connection
  judges every address the name resolves to and never follows a redirect (`upstream.py`). What
  the runner cannot call wrong is a well-formed public name that is not the provider's own; that
  is what the app's trust record is for.

A refusal never carries the address: it says only that the address may not hold the key.
"""

import re
from typing import Final
from urllib.parse import urlsplit

from code_reviewer_runner.dynamic_review.job_model_entry import JobModelEntry
from code_reviewer_runner.dynamic_review.passthrough.address import UpstreamRefused, check_base_url
from code_reviewer_runner.llm_providers import provider_for, upstream_base_is_the_providers

# The slug of a provider in the registries of the app and the runner (`LlmProviderId`).
PROVIDER_SLUG: Final = re.compile(r"^[a-z][a-z0-9_]{1,31}$")


def key_destination(provider: str, entry: JobModelEntry) -> str:
    """The address the key of `provider` is sent to for this entry, or `UpstreamRefused`."""
    if PROVIDER_SLUG.fullmatch(provider) is None or entry.provider_id != provider.replace("_", "-"):
        raise UpstreamRefused("the entry is not of the provider the key is for")
    address = entry.upstream_base_url
    if provider_for(provider) is not None:
        if not upstream_base_is_the_providers(provider, address):
            raise UpstreamRefused("the entry names an address that is not the provider's")
        # The connection (`HttpsUpstream`) judges the form of the registry's address as well.
        return address
    destination = check_base_url(address)
    # A provider of the catalog has a name: an IP literal of any kind (IPv4, bracketed IPv6, mapped,
    # with a zone id) is refused, as the app does, so neither side has to agree on which literals
    # count as public.
    host = urlsplit(destination).netloc
    if host.startswith("[") or re.fullmatch(r"[0-9.]+", host):
        raise UpstreamRefused("the entry names an IP address, not the name of the provider")
    if destination != address:
        raise UpstreamRefused(
            "the entry names an address in another spelling than the canonical one"
        )
    return destination
