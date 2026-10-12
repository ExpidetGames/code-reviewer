// SPDX-License-Identifier: Apache-2.0

// A web address that is safe to put in a link: only http(s), never a `javascript:` or `data:` address.

/** The address when it is an http(s) web address, otherwise null. */
export function webAddress(url: string): string | null {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
