// SPDX-License-Identifier: LicenseRef-Proprietary

// Invitations (docs/decisions/0001-editions-setup-and-accounts.md, section 2.6): how a person is brought
// into a workspace. The rules, all enforced here and not in the pages or routes in front of this module:
//
// Creating.
// - Owners invite with any role, Admins Members only, Members nobody (permissions.ts), judged from the role
//   the person has in the database when the invitation is made.
// - Only an address that the sign-up rule lets in can be invited, and none while the rule cannot be
//   evaluated safely (a rule that names addresses, with no way to verify them): the invitation does not
//   override the rule. The rule and its state are the ones of the sign-up itself (src/signup/).
// - The token is 256 random bits; only its SHA-256 hash is stored. The link is shown (or mailed) once; it
//   cannot be read back from the database. It works once, for 7 days, for the address it was made for.
// - With a mail server the link is mailed (MailSender). Without one it is returned to the person who
//   invited, to copy; a new link then needs a revoke and a new invitation. A resend (with a mail server)
//   replaces the token of the same invitation, which stops the old link.
// - An address that is a member already, or that has an open invitation, is refused (`already_member`,
//   `already_invited`), which tells an Admin nothing they cannot see on the member and invitation lists. An
//   address that has an account but is not a member gets exactly the answer of an address with none.
// - Counted in the shared rate_limits table (rate-limits.ts): per person, workspace, address and instance.
//
// Accepting.
// - The person is signed in with the address the invitation is bound to, and (while the instance can send
//   mail, or the sign-up rule names addresses) that address is verified; the instance admin needs no
//   verification. Without a mail server and under the rule "everyone" nothing can be verified, and the
//   link itself is the proof of the address.
// - The sign-up rule is checked again when the invitation is accepted (and when it is sent again): an
//   invitation made under "everyone" does not bring in an address that a tightened rule refuses
//   (`email_not_allowed`, `signup_closed`). The instance admin is exempt, as from the sign-up itself.
// - By the link (the token), or, with a mail server only, from the list of the invitations waiting for a
//   verified address. Without a mail server invitations are never found by an address.
// - One guarded statement uses the invitation up, so of two requests with one link only one succeeds;
//   accepting while already a member changes nothing about the role. Revoked, used and expired
//   invitations are refused with their own code, an unknown token with a generic one.
import type { Kysely } from "kysely";
import {
  hashLinkToken,
  isWellFormedLinkToken,
  newLinkToken,
} from "../admin-cli/token.ts";
import { signUpAvailability } from "../signup/availability.ts";
import { canonicalEmail, evaluateSignUpRule } from "../signup/rule.ts";
import { readSignUpFacts, type SignUpFacts } from "../signup/state.ts";
import {
  createInvitationDirectory,
  type InvitationWithWorkspace,
} from "../db/repositories/invitation-directory-repository.ts";
import {
  createInvitationsRepository,
  type Invitation,
} from "../db/repositories/invitations-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import { formatTimestamp } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";
import {
  invitationLink,
  invitationMessage,
} from "../mail/invitation-message.ts";
import type { MailSender } from "../mail/sender.ts";
import { canInviteAs, canRevokeInvitationOf } from "./permissions.ts";
import type { WorkspaceLimits } from "./rate-limits.ts";
import { isWorkspaceRole, type WorkspaceRole } from "./roles.ts";

/** How long an invitation works. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const INVITATION_ERROR_CODES = [
  /** The person who acts is not a member of the workspace (any more). */
  "not_found",
  /** The person is a member, and the role they have does not allow this. */
  "forbidden",
  "invalid_email",
  "invalid_role",
  /** The sign-up rule does not let this address in. */
  "email_not_allowed",
  /** The rule names addresses and nothing can verify them, so it cannot be evaluated safely. */
  "signup_closed",
  "already_member",
  "already_invited",
  /** A resend or a listing that needs a mail server, on an instance without one. */
  "not_available",
  "rate_limited",
  /** No invitation by this token or id (or it is not for the person who asks). */
  "invitation_not_found",
  "invitation_expired",
  "invitation_revoked",
  "invitation_used",
  /** The person is signed in with another address than the invitation is bound to. */
  "email_mismatch",
  /** The address of the signed in person is not verified, and it has to be. */
  "email_not_verified",
] as const;
export type InvitationErrorCode = (typeof INVITATION_ERROR_CODES)[number];

export const INVITATION_ERROR_STATUS: Record<InvitationErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid_email: 422,
  invalid_role: 422,
  email_not_allowed: 422,
  signup_closed: 403,
  already_member: 409,
  already_invited: 409,
  not_available: 404,
  rate_limited: 429,
  invitation_not_found: 404,
  invitation_expired: 410,
  invitation_revoked: 410,
  invitation_used: 409,
  email_mismatch: 403,
  email_not_verified: 403,
};

export type InvitationFailure = {
  ok: false;
  error: InvitationErrorCode;
  /** For `rate_limited`. */
  retryAfterSeconds?: number;
};

/** How the link reaches the person: by mail, or shown to the person who invited (no mail server, or it failed). */
export type InvitationDelivery =
  | { kind: "mailed" }
  | { kind: "link"; link: string; reason: "no_mail_server" | "mail_failed" };

export type OpenInvitation = {
  id: string;
  email: string;
  role: WorkspaceRole;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
};

export type InvitationPreview = {
  workspaceName: string;
  role: WorkspaceRole;
  email: string;
};

export type PendingInvitation = {
  id: string;
  workspaceName: string;
  role: WorkspaceRole;
  expiresAt: string;
};

export type Acceptor = {
  id: string;
  email: string;
  emailVerified: boolean;
  isInstanceAdmin: boolean;
};

export type AcceptResult =
  | {
      ok: true;
      workspace: { slug: string; name: string };
      /** The role the person has in the workspace now. */
      role: WorkspaceRole;
      /** They were a member already: nothing about their role changed. */
      alreadyMember: boolean;
    }
  | InvitationFailure;

export type InvitationService = {
  create(input: {
    workspaceId: string;
    workspaceName: string;
    actorId: string;
    inviterName: string;
    email: unknown;
    role: unknown;
  }): Promise<
    | { ok: true; invitation: OpenInvitation; delivery: InvitationDelivery }
    | InvitationFailure
  >;
  resend(input: {
    workspaceId: string;
    workspaceName: string;
    actorId: string;
    inviterName: string;
    invitationId: string;
  }): Promise<
    | { ok: true; invitation: OpenInvitation; delivery: InvitationDelivery }
    | InvitationFailure
  >;
  revoke(input: {
    workspaceId: string;
    actorId: string;
    invitationId: string;
  }): Promise<{ ok: true } | InvitationFailure>;
  /** The invitations of the workspace that have not been accepted or revoked, newest first. */
  listOpen(workspaceId: string): Promise<OpenInvitation[]>;
  /** What a link is about, for the page behind it. Not counted: it changes nothing. */
  preview(
    token: unknown,
  ): Promise<{ ok: true; preview: InvitationPreview } | InvitationFailure>;
  accept(
    input: { token: unknown } | { invitationId: unknown },
    acceptor: Acceptor,
  ): Promise<AcceptResult>;
  /** The open invitations waiting for the address of a verified account, with a mail server only. */
  listPendingFor(acceptor: Acceptor): Promise<PendingInvitation[]>;
};

export type InvitationServiceDependencies = {
  db: Kysely<Database>;
  mail: MailSender;
  limits: WorkspaceLimits;
  /** The configured public address of the app: a link never comes from a request header. */
  baseUrl: string;
  /** Whether sign-in with GitHub exists (the facts of the sign-up rule). */
  githubConfigured: () => boolean | Promise<boolean>;
  now?: () => Date;
  newId?: () => string;
  newToken?: () => string;
  log?: (message: string) => void;
};

/** What a transaction that makes or renews an invitation answers. */
type Made = { ok: true; invitation: Invitation } | InvitationFailure;

function toOpen(invitation: Invitation, now: Date): OpenInvitation {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    expired: invitation.expiresAt <= formatTimestamp(now),
  };
}

export function createInvitationService(
  dependencies: InvitationServiceDependencies,
): InvitationService {
  const { db, mail, limits, baseUrl, githubConfigured } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? (() => crypto.randomUUID());
  const newToken = dependencies.newToken ?? newLinkToken;
  const log = dependencies.log ?? console.error;
  const directory = () => createInvitationDirectory(db, now);

  const facts = (): Promise<SignUpFacts> =>
    readSignUpFacts({ db, mail, githubConfigured });

  /** The status of an invitation found by token or id, as the code the person is told. */
  function statusFailure(invitation: Invitation): InvitationFailure | null {
    if (invitation.acceptedAt !== null)
      return { ok: false, error: "invitation_used" };
    if (invitation.revokedAt !== null)
      return { ok: false, error: "invitation_revoked" };
    if (invitation.expiresAt <= formatTimestamp(now()))
      return { ok: false, error: "invitation_expired" };
    return null;
  }

  /** Sends the link, or hands it back to the person who invited. Never throws. */
  async function deliver(input: {
    to: string;
    link: string;
    workspaceName: string;
    inviterName: string;
    role: WorkspaceRole;
  }): Promise<InvitationDelivery> {
    try {
      if (!(await mail.isConfigured()))
        return { kind: "link", link: input.link, reason: "no_mail_server" };
      const result = await mail.send(
        invitationMessage({
          to: input.to,
          link: input.link,
          workspaceName: input.workspaceName,
          inviterName: input.inviterName,
          role: input.role,
          validForDays: INVITATION_TTL_MS / (24 * 60 * 60 * 1000),
        }),
      );
      if (result.ok) return { kind: "mailed" };
      log(
        `[invitations] INVITATION_MAIL_FAILED: an invitation mail was not sent (${result.error}).`,
      );
    } catch {
      log(
        "[invitations] INVITATION_MAIL_FAILED: an invitation mail was not sent (error).",
      );
    }
    return { kind: "link", link: input.link, reason: "mail_failed" };
  }

  /**
   * The sign-up rule as it is now, for an address: a refusal while the rule cannot be evaluated safely
   * (`signup_closed`) or does not let the address in (`email_not_allowed`). Used when an invitation is made, when
   * it is sent again and when it is accepted, so an invitation never outlives the rule it was made under. An
   * instance without email sign-up (GitHub only) is no refusal here: the invited person signs in with GitHub and
   * the rule is applied to their verified address.
   */
  function ruleRefusal(
    state: SignUpFacts,
    email: string,
  ): InvitationFailure | null {
    const availability = signUpAvailability(state);
    if (!availability.open && availability.error === "signup_closed")
      return { ok: false, error: "signup_closed" };
    const verdict = evaluateSignUpRule(state.rule, email);
    return verdict.ok ? null : { ok: false, error: verdict.error };
  }

  /** The role of a person in a workspace, from the database right now. */
  async function roleOf(workspaceId: string, userId: string) {
    return (await createWorkspaceMembersRepository(db, workspaceId).get(userId))
      ?.role;
  }

  return {
    async create({
      workspaceId,
      workspaceName,
      actorId,
      inviterName,
      email: rawEmail,
      role,
    }) {
      if (!isWorkspaceRole(role)) return { ok: false, error: "invalid_role" };
      // Who may invite comes first and costs the caller nothing but the answer: a Member burns no counter.
      const actorRole = await roleOf(workspaceId, actorId);
      if (actorRole === undefined) return { ok: false, error: "not_found" };
      if (!canInviteAs(actorRole, role))
        return { ok: false, error: "forbidden" };

      const email = canonicalEmail(rawEmail);
      if (email === null) return { ok: false, error: "invalid_email" };

      const permission = await limits.invite({
        userId: actorId,
        workspaceId,
        email,
      });
      if (!permission.allowed)
        return {
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: permission.retryAfterSeconds,
        };

      // The rule: the one of the sign-up, evaluated now. While it cannot be evaluated safely nobody is
      // invited; an instance without email sign-up (GitHub only) still invites, because the invited
      // person signs in with GitHub and the rule is applied to their verified address.
      const refusal = ruleRefusal(await facts(), email);
      if (refusal !== null) return refusal;

      const token = newToken();
      const created = await db
        .transaction()
        .execute(async (trx): Promise<Made> => {
          const members = createWorkspaceMembersRepository(
            trx,
            workspaceId,
            now,
          );
          await members.lock();
          // Judged again inside the transaction: the person may have been demoted or removed a moment ago.
          const current = (await members.get(actorId))?.role;
          if (current === undefined) return { ok: false, error: "not_found" };
          if (!canInviteAs(current, role))
            return { ok: false, error: "forbidden" };

          const existing = await trx
            .selectFrom("workspace_members")
            .innerJoin("users", "users.id", "workspace_members.user_id")
            .select("users.id")
            .where("workspace_members.workspace_id", "=", workspaceId)
            .where("users.email", "=", email)
            .executeTakeFirst();
          if (existing !== undefined)
            return { ok: false, error: "already_member" };

          const invitations = createInvitationsRepository(
            trx,
            workspaceId,
            now,
          );
          // An invitation that ran out is over: it makes room for a new one instead of blocking it.
          await invitations.revokeExpiredFor(email);
          if ((await invitations.findOpenByEmail(email)) !== undefined)
            return { ok: false, error: "already_invited" };

          return {
            ok: true,
            invitation: await invitations.create({
              id: newId(),
              email,
              role,
              invitedBy: actorId,
              tokenHash: hashLinkToken(token),
              expiresAt: new Date(now().getTime() + INVITATION_TTL_MS),
            }),
          };
        });
      if (!created.ok) return created;

      const delivery = await deliver({
        to: email,
        link: invitationLink(baseUrl, token),
        workspaceName,
        inviterName,
        role,
      });
      return {
        ok: true,
        invitation: toOpen(created.invitation, now()),
        delivery,
      };
    },

    async resend({
      workspaceId,
      workspaceName,
      actorId,
      inviterName,
      invitationId,
    }) {
      const actorRole = await roleOf(workspaceId, actorId);
      if (actorRole === undefined) return { ok: false, error: "not_found" };
      // A new link needs a mail server: without one it would have to be shown again, and a link is shown once.
      if (!(await mail.isConfigured()))
        return { ok: false, error: "not_available" };

      const found = await createInvitationsRepository(db, workspaceId, now).get(
        invitationId,
      );
      if (
        found === undefined ||
        found.acceptedAt !== null ||
        found.revokedAt !== null
      )
        return { ok: false, error: "invitation_not_found" };
      if (!canInviteAs(actorRole, found.role))
        return { ok: false, error: "forbidden" };

      // The rule may have been tightened since the invitation was made: no new link for an address that the
      // rule does not let in any more (revoking it is still possible).
      const refusal = ruleRefusal(await facts(), found.email);
      if (refusal !== null) return refusal;

      const permission = await limits.invite({
        userId: actorId,
        workspaceId,
        email: found.email,
      });
      if (!permission.allowed)
        return {
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: permission.retryAfterSeconds,
        };

      const token = newToken();
      const replaced = await db
        .transaction()
        .execute(async (trx): Promise<Made> => {
          const members = createWorkspaceMembersRepository(
            trx,
            workspaceId,
            now,
          );
          await members.lock();
          const current = (await members.get(actorId))?.role;
          if (current === undefined) return { ok: false, error: "not_found" };
          const invitations = createInvitationsRepository(
            trx,
            workspaceId,
            now,
          );
          const row = await invitations.get(invitationId);
          if (row === undefined)
            return { ok: false, error: "invitation_not_found" };
          if (!canInviteAs(current, row.role))
            return { ok: false, error: "forbidden" };
          const replacedToken = await invitations.replaceToken(
            invitationId,
            hashLinkToken(token),
            new Date(now().getTime() + INVITATION_TTL_MS),
          );
          if (!replacedToken)
            return { ok: false, error: "invitation_not_found" };
          return {
            ok: true,
            invitation: (await invitations.get(invitationId)) ?? row,
          };
        });
      if (!replaced.ok) return replaced;

      const delivery = await deliver({
        to: replaced.invitation.email,
        link: invitationLink(baseUrl, token),
        workspaceName,
        inviterName,
        role: replaced.invitation.role,
      });
      return {
        ok: true,
        invitation: toOpen(replaced.invitation, now()),
        delivery,
      };
    },

    async revoke({ workspaceId, actorId, invitationId }) {
      return db.transaction().execute(async (trx) => {
        const members = createWorkspaceMembersRepository(trx, workspaceId, now);
        await members.lock();
        const actor = await members.get(actorId);
        if (actor === undefined) return { ok: false, error: "not_found" };
        const invitations = createInvitationsRepository(trx, workspaceId, now);
        const found = await invitations.get(invitationId);
        if (
          found === undefined ||
          found.acceptedAt !== null ||
          found.revokedAt !== null
        )
          return { ok: false, error: "invitation_not_found" };
        if (!canRevokeInvitationOf(actor.role, found.role))
          return { ok: false, error: "forbidden" };
        await invitations.revoke(invitationId);
        return { ok: true };
      });
    },

    async listOpen(workspaceId) {
      const rows = await createInvitationsRepository(
        db,
        workspaceId,
        now,
      ).listOpen();
      return rows.map((row) => toOpen(row, now()));
    },

    async preview(token) {
      if (!isWellFormedLinkToken(token))
        return { ok: false, error: "invitation_not_found" };
      const found = await directory().findByTokenHash(hashLinkToken(token));
      if (found === undefined)
        return { ok: false, error: "invitation_not_found" };
      const failure = statusFailure(found);
      if (failure !== null) return failure;
      return {
        ok: true,
        preview: {
          workspaceName: found.workspaceName,
          role: found.role,
          email: found.email,
        },
      };
    },

    async accept(input, acceptor) {
      // Every attempt counts against the person, whatever the token: tampered tokens are limited too.
      const person = await limits.acceptByPerson(acceptor.id);
      if (!person.allowed)
        return {
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: person.retryAfterSeconds,
        };

      const state = await facts();
      let found: InvitationWithWorkspace | undefined;
      if ("token" in input) {
        if (!isWellFormedLinkToken(input.token))
          return { ok: false, error: "invitation_not_found" };
        found = await directory().findByTokenHash(hashLinkToken(input.token));
      } else {
        // From the list: only while the instance can send mail, so the address was verified by a mail.
        // Without one, an invitation is never found by an address, only by its link.
        if (!state.mailConfigured || typeof input.invitationId !== "string")
          return { ok: false, error: "invitation_not_found" };
        found = await directory().findById(input.invitationId);
      }
      if (found === undefined)
        return { ok: false, error: "invitation_not_found" };

      // Attempts against a link that exists are counted per link; one that does not exist touches nothing.
      const tokenPermission = await limits.acceptToken(found.id);
      if (!tokenPermission.allowed)
        return {
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: tokenPermission.retryAfterSeconds,
        };

      // An invitation from the list is the person's own only if it is for their address and that address
      // is verified: the list is found by looking up the address, which only a mail can have proven (the
      // instance admin is no exception here). Anything else looks like an id nobody has.
      const address = canonicalEmail(acceptor.email);
      if (
        "invitationId" in input &&
        (address !== found.email || !acceptor.emailVerified)
      )
        return { ok: false, error: "invitation_not_found" };

      const failure = statusFailure(found);
      if (failure !== null) return failure;
      if (address !== found.email)
        return { ok: false, error: "email_mismatch" };

      // The rule is the one of now, not the one the invitation was made under: an invitation made under
      // "everyone" does not let in an address that a tightened rule refuses. The instance admin is exempt, as
      // they are from the sign-up itself (their account exists whatever the rule says).
      if (!acceptor.isInstanceAdmin) {
        const refusal = ruleRefusal(state, found.email);
        if (refusal !== null) return refusal;
      }

      // The address has to be verified: always while a mail server exists, and always under a rule that
      // names addresses (it means nothing for an address nobody verified). The instance admin is exempt.
      // Only "everyone" without a mail server leaves nothing to verify; there the link is the proof.
      const needsVerification =
        state.mailConfigured || state.rule.kind !== "everyone";
      if (
        needsVerification &&
        !acceptor.emailVerified &&
        !acceptor.isInstanceAdmin
      )
        return { ok: false, error: "email_not_verified" };

      return db.transaction().execute(async (trx): Promise<AcceptResult> => {
        const invitations = createInvitationsRepository(
          trx,
          found.workspaceId,
          now,
        );
        const members = createWorkspaceMembersRepository(
          trx,
          found.workspaceId,
          now,
        );
        await members.lock();
        const used = await invitations.markAccepted(found.id, acceptor.id);
        if (!used) {
          // Somebody else got there first, or it was revoked a moment ago: say which, from the row now.
          const again = await invitations.get(found.id);
          const reason = again === undefined ? null : statusFailure(again);
          return reason ?? { ok: false, error: "invitation_not_found" };
        }
        const outcome = await members.add(acceptor.id, found.role);
        const member = await members.get(acceptor.id);
        return {
          ok: true,
          workspace: { slug: found.workspaceSlug, name: found.workspaceName },
          role: member?.role ?? found.role,
          alreadyMember: outcome === "existing",
        };
      });
    },

    async listPendingFor(acceptor) {
      // Only with a mail server, only for a verified address: nothing is found by looking up an address
      // that no mail has proven.
      if (!(await mail.isConfigured()) || !acceptor.emailVerified) return [];
      const address = canonicalEmail(acceptor.email);
      if (address === null) return [];
      const rows = await directory().listOpenForEmail(address);
      return rows.map((row) => ({
        id: row.id,
        workspaceName: row.workspaceName,
        role: row.role,
        expiresAt: row.expiresAt,
      }));
    },
  };
}
