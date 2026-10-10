// The hook for "who may use this instance". Today every GitHub account that signs in may. CR-19
// (allow list by GitHub login or organization) replaces `accessPolicy` below with the real rule;
// nothing else has to change, because both places that grant access go through it: the proxy
// (every request) and `getCurrentUser` (every page that shows the user).

/** The part of the signed in user that an access rule may look at. */
export type SessionUser = {
  id: string;
  name: string;
  /** The current GitHub login (refreshed at every sign in). */
  githubLogin: string;
};

/**
 * Decides whether a signed in user may use the app. It runs on every authenticated request, so a
 * rule that is checked per request (for example a list of logins) takes effect immediately.
 * Returning false treats the request like one without a session.
 */
export type AccessPolicy = (user: SessionUser) => boolean | Promise<boolean>;

export const allowEveryone: AccessPolicy = () => true;

export const accessPolicy: AccessPolicy = allowEveryone;
