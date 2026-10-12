// SPDX-License-Identifier: Apache-2.0

// Sentences that several message modules used to repeat word for word (#169). Each one has exactly one
// owner here; the feature modules import it and never write the words again. The copy-ownership test
// (`ownership.test.ts`) fails when a second module writes one of them.

/** A request that did not carry the header of our own pages, where the sentence is short. */
export const CROSS_SITE_REQUEST =
  "The request did not come from this page. Reload it.";
/** The same, where the module already words the next step as "reload the page and try again". */
export const CROSS_SITE_REQUEST_RELOAD_PAGE =
  "The request did not come from this page. Reload the page and try again.";
/** A body the route could not read at all. */
export const REQUEST_NOT_UNDERSTOOD =
  "The request was not understood. Reload the page and try again.";
/** A route that is switched off right now. */
export const UNAVAILABLE =
  "This is not available right now. Please try again later.";
/** The rate limit of a call that asks for something. */
export const TOO_MANY_ATTEMPTS =
  "Too many attempts. Wait a while and try again.";
/** A resource of another workspace or that does not exist. */
export const NOT_AVAILABLE_TO_YOU = "That is not available to you.";
/** The whole form was refused. */
export const INVALID_VALUES =
  "Some of the values are not valid. Check the fields.";
/** The role in the workspace does not allow the call. */
export const ROLE_NOT_ALLOWED =
  "Your role in this workspace does not allow that.";
/** The session ended; the person has to sign in again. */
export const SESSION_ENDED = "Your session has ended. Sign in again.";

/** An address that is not an email address. */
export const INVALID_EMAIL = "Enter a valid email address.";
/** A rule that must name at least one address or domain. */
export const ENTRIES_REQUIRED = "Enter at least one entry.";
/** One of the listed entries is neither an email address nor a domain. */
export const ENTRY_INVALID =
  "One of the entries is not valid. Emails look like name@example.com, domains like example.com.";
/** More entries than the rule accepts. */
export const TOO_MANY_ENTRIES = "There are too many entries (500 at most).";
