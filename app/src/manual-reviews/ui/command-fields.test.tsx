// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the choice of the command: the four commands are offered, the question field exists
// for `ask` only, and a command the project switched off is shown but cannot be picked.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewCommand } from "../../integrations/types.ts";
import { CommandFields } from "./command-fields.tsx";

afterEach(cleanup);

function renderFields(
  props: {
    command?: ReviewCommand;
    allowed?: ReviewCommand[];
    questionError?: string | null;
    onCommand?: (command: ReviewCommand) => void;
    onQuestion?: (question: string) => void;
  } = {},
) {
  return render(
    <CommandFields
      command={props.command ?? "review"}
      onCommand={props.onCommand ?? (() => undefined)}
      question=""
      onQuestion={props.onQuestion ?? (() => undefined)}
      questionError={props.questionError ?? null}
      allowedCommands={
        props.allowed ?? ["review", "improve", "describe", "ask"]
      }
      disabled={false}
    />,
  );
}

describe("the command choice", () => {
  // CR-33-T05
  it("offers review, improve, describe and ask", () => {
    renderFields();

    const options = screen
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);
    expect(options).toEqual(["review", "improve", "describe", "ask"]);
  });

  // CR-33-T05
  it.each(["review", "improve", "describe"] as const)(
    "shows no question field for %s",
    (command) => {
      renderFields({ command });

      expect(screen.queryByLabelText("Question")).toBeNull();
    },
  );

  // CR-33-T05
  it("shows the question field for ask only", () => {
    renderFields({ command: "ask" });

    expect(screen.getByLabelText("Question")).toBeTruthy();
  });

  it("reports the command that was picked and the question that was typed", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn();
    const onQuestion = vi.fn();
    const { rerender } = renderFields({ onCommand, onQuestion });

    await user.selectOptions(screen.getByLabelText("Command to run"), "ask");
    rerender(
      <CommandFields
        command="ask"
        onCommand={onCommand}
        question=""
        onQuestion={onQuestion}
        questionError={null}
        allowedCommands={["review", "improve", "describe", "ask"]}
        disabled={false}
      />,
    );
    await user.type(screen.getByLabelText("Question"), "Why?");

    expect(onCommand).toHaveBeenCalledWith("ask");
    expect(onQuestion).toHaveBeenLastCalledWith("?");
  });

  it("shows a command the project switched off as unavailable", () => {
    renderFields({ allowed: ["review"] });

    const improve = screen.getByRole("option", {
      name: /Improve/,
    }) as HTMLOptionElement;
    expect(improve.disabled).toBe(true);
    expect(improve.textContent).toContain("switched off for this project");
    expect(
      (screen.getByRole("option", { name: "Review" }) as HTMLOptionElement)
        .disabled,
    ).toBe(false);
  });

  it("shows the problem with the question next to it", () => {
    renderFields({ command: "ask", questionError: "Write a question." });

    expect(screen.getByRole("alert").textContent).toBe("Write a question.");
    expect(screen.getByLabelText("Question").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });
});
