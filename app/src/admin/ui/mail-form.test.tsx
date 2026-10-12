// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the mail page's building blocks: what the form sends (an empty password field sends none, the
// checkbox sends the clear), the sentence for every field the server refuses, the warnings for a connection
// without encryption and for a certificate that is not checked, that a saved password is never shown, and
// the test mail button with the words for each class of failure.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { AdminSettingsView } from "../service.ts";
import type { AdminApi, SettingChange, TestMailAnswer } from "./api.ts";
import { MailForm } from "./mail-form.tsx";
import { TestMailPanel } from "./test-mail-panel.tsx";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

afterEach(cleanup);

const SAVED_SETTINGS = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  user: "mailer",
  senderAddress: "reviewer@example.com",
  senderName: "Code Reviewer",
  allowSelfSigned: false,
  allowPlainTextLogin: false,
} as const;

function view(
  smtp: Partial<AdminSettingsView["smtp"]> = {},
): AdminSettingsView {
  const never = { updatedBy: null, updatedAt: null };
  return {
    tenancy: { value: "single", ...never },
    signUpRule: { value: { kind: "everyone" }, ...never },
    signInMethods: {
      value: { emailPassword: true, github: false },
      effective: { emailPassword: true, github: false },
      ...never,
    },
    maxWorkspacesPerUser: { value: 10, ...never },
    smtp: { value: null, password: "none", ...never, ...smtp },
    workspaceCount: 1,
    githubConfigured: false,
    mailConfigured: false,
    signUpRuleState: { failClosed: false },
    secrets: [],
    setupCompletedAt: "2026-10-12T08:00:00.000Z",
    importNotice: null,
  };
}

const configured = (extra: Partial<AdminSettingsView["smtp"]> = {}) =>
  view({
    value: SAVED_SETTINGS,
    password: "configured",
    updatedBy: { id: "admin-1", email: "admin@example.com" },
    updatedAt: "2026-10-12T08:00:00.000Z",
    ...extra,
  });

function api(
  changeResult: RequestResult<{ ok: true; settings: AdminSettingsView }> = {
    ok: true,
    data: { ok: true, settings: view() },
  },
  testMail: RequestResult<TestMailAnswer> = { ok: true, data: { ok: true } },
) {
  const changeMock = vi.fn<
    (change: SettingChange) => Promise<typeof changeResult>
  >(() => Promise.resolve(changeResult));
  const testMock = vi.fn<AdminApi["testMail"]>(() => Promise.resolve(testMail));
  return {
    api: { change: changeMock, testMail: testMock } satisfies AdminApi,
    changeMock,
    testMock,
  };
}

describe("the mail form", () => {
  it("sends what was typed, without a password field that was left empty", async () => {
    const { api: mock, changeMock } = api();
    const user = userEvent.setup();
    render(<MailForm settings={configured()} api={mock} />);

    await user.clear(screen.getByLabelText("Host"));
    await user.type(screen.getByLabelText("Host"), "mail.example.org");
    await user.click(screen.getByRole("button", { name: "Save mail server" }));

    await waitFor(() => expect(changeMock).toHaveBeenCalled());
    expect(changeMock).toHaveBeenCalledWith({
      smtp: {
        host: "mail.example.org",
        port: 587,
        security: "starttls",
        user: "mailer",
        senderAddress: "reviewer@example.com",
        senderName: "Code Reviewer",
        allowSelfSigned: false,
        allowPlainTextLogin: false,
      },
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Saved."),
    );
    expect(navigation.refresh).toHaveBeenCalled();
  });

  it("sends a new password, and then empties the field", async () => {
    const { api: mock, changeMock } = api();
    const user = userEvent.setup();
    render(<MailForm settings={configured()} api={mock} />);

    await user.type(screen.getByLabelText("Password"), "new-password-value");
    await user.click(screen.getByRole("button", { name: "Save mail server" }));

    await waitFor(() => expect(changeMock).toHaveBeenCalled());
    expect(changeMock.mock.calls[0]?.[0]).toMatchObject({
      smtp: { password: "new-password-value" },
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Password") as HTMLInputElement).value,
      ).toBe(""),
    );
  });

  // #100-SM-02
  it("sends the explicit clear when the box is ticked", async () => {
    const { api: mock, changeMock } = api();
    const user = userEvent.setup();
    render(<MailForm settings={configured()} api={mock} />);

    await user.click(
      screen.getByRole("checkbox", { name: "Remove the saved password" }),
    );
    await user.click(screen.getByRole("button", { name: "Save mail server" }));

    await waitFor(() => expect(changeMock).toHaveBeenCalled());
    expect(changeMock.mock.calls[0]?.[0]).toMatchObject({
      smtp: { clearPassword: true },
    });
    expect(JSON.stringify(changeMock.mock.calls[0]?.[0])).not.toContain(
      '"password"',
    );
  });

  // #100-SM-01
  it("says that a password is saved and never has it", () => {
    render(<MailForm settings={configured()} api={api().api} />);

    expect(screen.getByText(/A password is saved/)).toBeTruthy();
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("says that none is saved when there is none, and offers no clear", () => {
    render(<MailForm settings={view()} api={api().api} />);

    expect(screen.getByText(/No password is saved/)).toBeTruthy();
    expect(
      screen.queryByRole("checkbox", { name: "Remove the saved password" }),
    ).toBeNull();
  });

  // #100-SM-15
  it("tells the admin to enter a password that cannot be read again", () => {
    render(
      <MailForm
        settings={configured({ password: "unreadable" })}
        api={api().api}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("cannot be read");
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter the password again",
    );
  });

  // #100-SM-03
  it("shows the sentence for each field the server refuses", async () => {
    const { api: mock } = api({
      ok: false,
      status: 422,
      code: "invalid_input",
      issues: [
        { field: "host", code: "host_invalid" },
        { field: "port", code: "port_not_allowed" },
        { field: "senderAddress", code: "sender_invalid" },
        { field: "senderName", code: "sender_name_invalid" },
        { field: "password", code: "password_required" },
      ],
    });
    const user = userEvent.setup();
    render(<MailForm settings={view()} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Save mail server" }));

    await waitFor(() =>
      expect(screen.getByText(/not a host name or an IP address/)).toBeTruthy(),
    );
    expect(screen.getByText(/Below 1024 only the ports of mail/)).toBeTruthy();
    expect(screen.getByText(/not a valid sender address/)).toBeTruthy();
    expect(
      screen.getByText(/longer than 100 characters or contains a line break/),
    ).toBeTruthy();
    expect(screen.getByText(/Enter the password of this login/)).toBeTruthy();
    expect(screen.getByLabelText("Host").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  it("follows the usual port when the security changes, and a port that was typed stays", async () => {
    const user = userEvent.setup();
    render(<MailForm settings={view()} api={api().api} />);

    await user.click(screen.getByRole("radio", { name: /^TLS/ }));
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe(
      "465",
    );
    await user.clear(screen.getByLabelText("Port"));
    await user.type(screen.getByLabelText("Port"), "2525");
    await user.click(screen.getByRole("radio", { name: /^STARTTLS/ }));
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe(
      "2525",
    );
  });

  it("warns about a connection that is not encrypted, and has no self-signed option for it", async () => {
    const user = userEvent.setup();
    render(<MailForm settings={view()} api={api().api} />);

    await user.click(screen.getByRole("radio", { name: /None/ }));

    expect(screen.getByRole("note").textContent).toContain("not encrypted");
    expect(
      screen.queryByRole("checkbox", {
        name: "Accept a self-signed certificate",
      }),
    ).toBeNull();
  });

  it("warns when the certificate check is switched off", async () => {
    const { api: mock, changeMock } = api();
    const user = userEvent.setup();
    render(<MailForm settings={view()} api={mock} />);
    expect(screen.queryByRole("note")).toBeNull();

    await user.click(
      screen.getByRole("checkbox", {
        name: "Accept a self-signed certificate",
      }),
    );

    expect(screen.getByRole("note").textContent).toContain(
      "not checked at all",
    );
    await user.type(screen.getByLabelText("Host"), "mail.internal");
    await user.type(screen.getByLabelText("Sender address"), "a@example.com");
    await user.click(screen.getByRole("button", { name: "Save mail server" }));
    await waitFor(() => expect(changeMock).toHaveBeenCalled());
    expect(changeMock.mock.calls[0]?.[0]).toMatchObject({
      smtp: { allowSelfSigned: true },
    });
  });

  // #100-review-6
  it("asks for a second confirmation before a login goes out without encryption, and sends it only when ticked", async () => {
    const { api: mock, changeMock } = api();
    const user = userEvent.setup();
    render(<MailForm settings={configured()} api={mock} />);

    await user.click(screen.getByRole("radio", { name: /None/ }));
    const confirmBox = screen.getByRole("checkbox", {
      name: "I understand that the login is sent without encryption",
    });
    expect(
      screen.getByText(/password would be sent in the clear/),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save mail server" }));
    await waitFor(() => expect(changeMock).toHaveBeenCalledTimes(1));
    expect(changeMock.mock.calls[0]?.[0]).toMatchObject({
      smtp: { security: "none", allowPlainTextLogin: false },
    });
    await user.click(confirmBox);
    await user.click(screen.getByRole("button", { name: "Save mail server" }));

    await waitFor(() => expect(changeMock).toHaveBeenCalledTimes(2));
    expect(changeMock.mock.calls[1]?.[0]).toMatchObject({
      smtp: { security: "none", allowPlainTextLogin: true },
    });
  });

  it("has no confirmation without a login or with encryption, and shows the server's refusal in words", async () => {
    const { api: mock } = api({
      ok: false,
      status: 422,
      code: "invalid_input",
      issues: [
        {
          field: "allowPlainTextLogin",
          code: "plain_text_login_not_confirmed",
        },
        { field: "password", code: "password_required_for_new_server" },
      ],
    });
    const user = userEvent.setup();
    render(<MailForm settings={configured()} api={mock} />);
    expect(
      screen.queryByRole("checkbox", {
        name: /login is sent without encryption/,
      }),
    ).toBeNull();
    await user.click(screen.getByRole("radio", { name: /None/ }));
    await user.click(screen.getByRole("button", { name: "Save mail server" }));

    await waitFor(() =>
      expect(screen.getByText(/Tick the box to confirm that/)).toBeTruthy(),
    );
    expect(
      screen.getByText(/only works for the server it was entered for/),
    ).toBeTruthy();
    await user.clear(screen.getByLabelText("User"));
    expect(
      screen.queryByRole("checkbox", {
        name: /login is sent without encryption/,
      }),
    ).toBeNull();
  });

  // #100-SM-07
  it("removes the mail server only after a second click", async () => {
    const { api: mock, changeMock } = api();
    const user = userEvent.setup();
    render(<MailForm settings={configured()} api={mock} />);

    await user.click(
      screen.getByRole("button", { name: "Remove the mail server" }),
    );
    expect(changeMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Yes, remove it" }));

    await waitFor(() =>
      expect(changeMock).toHaveBeenCalledWith({ smtp: null }),
    );
    // The form starts empty again.
    await waitFor(() =>
      expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe(
        "",
      ),
    );
    expect((screen.getByLabelText("User") as HTMLInputElement).value).toBe("");
  });

  it("offers no removal when there is no mail server", () => {
    render(<MailForm settings={view()} api={api().api} />);

    expect(
      screen.queryByRole("button", { name: "Remove the mail server" }),
    ).toBeNull();
  });
});

describe("the test mail button", () => {
  // #100-SM-04
  it("sends the test mail and says where to look", async () => {
    const { api: mock, testMock } = api();
    const user = userEvent.setup();
    render(
      <TestMailPanel configured adminEmail="admin@example.com" api={mock} />,
    );

    await user.click(screen.getByRole("button", { name: "Send test mail" }));

    await waitFor(() =>
      expect(screen.getByText(/handed to the mail server/)).toBeTruthy(),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "admin@example.com",
    );
    expect(testMock).toHaveBeenCalledTimes(1);
  });

  it("is off until a mail server is saved", () => {
    render(
      <TestMailPanel
        configured={false}
        adminEmail="admin@example.com"
        api={api().api}
      />,
    );

    expect(
      (
        screen.getByRole("button", {
          name: "Send test mail",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  // #100-SM-05
  it.each([
    ["dns_failure", "host name could not be found"],
    ["connection_refused", "Nothing answered on that host and port"],
    ["tls_error", "secure connection to the mail server could not be set up"],
    ["auth_failed", "refused the login"],
    ["sender_rejected", "does not accept the sender address"],
    ["timeout", "did not answer in time"],
    ["password_unreadable", "cannot be read"],
    ["unknown", "could not be sent"],
  ])("says what a %s means", async (error, sentence) => {
    const { api: mock } = api(undefined, {
      ok: true,
      data: {
        ok: false,
        error,
        detail: "535 5.7.8 Authentication credentials invalid",
      },
    });
    const user = userEvent.setup();
    render(
      <TestMailPanel configured adminEmail="admin@example.com" api={mock} />,
    );

    await user.click(screen.getByRole("button", { name: "Send test mail" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(sentence),
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "535 5.7.8 Authentication credentials invalid",
    );
  });

  it("says that it was asked for too often", async () => {
    const { api: mock } = api(undefined, {
      ok: false,
      status: 429,
      code: "rate_limited",
      issues: [],
    });
    const user = userEvent.setup();
    render(
      <TestMailPanel configured adminEmail="admin@example.com" api={mock} />,
    );

    await user.click(screen.getByRole("button", { name: "Send test mail" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Too many test mails",
      ),
    );
  });
});
