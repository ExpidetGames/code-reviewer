// The command of a manual start and, for `ask`, the question. The four commands are always listed;
// one the project switched off is shown but cannot be picked. The question field appears only for
// `ask`.
import { useId } from "react";
import {
  REVIEW_COMMANDS,
  type ReviewCommand,
} from "../../integrations/types.ts";
import { ASK_QUESTION_MAX_CHARS } from "../../integrations/comment-command.ts";

const COMMAND_COPY: Record<ReviewCommand, { label: string; hint: string }> = {
  review: {
    label: "Review",
    hint: "Reads the changes and posts a review with its findings on the pull request.",
  },
  improve: {
    label: "Improve",
    hint: "Posts code suggestions for the changes.",
  },
  describe: {
    label: "Describe",
    hint: "Writes a title and a description for the pull request.",
  },
  ask: {
    label: "Ask",
    hint: "Answers a question about the changes in a comment.",
  },
};

export function CommandFields({
  command,
  onCommand,
  question,
  onQuestion,
  questionError,
  allowedCommands,
  disabled,
}: {
  command: ReviewCommand;
  onCommand: (command: ReviewCommand) => void;
  question: string;
  onQuestion: (question: string) => void;
  /** The sentence to show under the question, or null. */
  questionError: string | null;
  allowedCommands: readonly ReviewCommand[];
  disabled: boolean;
}) {
  const ids = useId();
  const commandId = `${ids}-command`;
  const hintId = `${ids}-hint`;
  const questionId = `${ids}-question`;
  const errorId = `${ids}-question-error`;
  return (
    <>
      <div className="field">
        <label htmlFor={commandId} className="field-label">
          Command to run
        </label>
        <select
          id={commandId}
          value={command}
          aria-describedby={hintId}
          disabled={disabled}
          onChange={(event) => onCommand(event.target.value as ReviewCommand)}
        >
          {REVIEW_COMMANDS.map((candidate) => (
            <option
              key={candidate}
              value={candidate}
              disabled={!allowedCommands.includes(candidate)}
            >
              {COMMAND_COPY[candidate].label}
              {allowedCommands.includes(candidate)
                ? ""
                : " (switched off for this project)"}
            </option>
          ))}
        </select>
        <p id={hintId} className="muted small">
          {COMMAND_COPY[command].hint}
        </p>
      </div>
      {command === "ask" ? (
        <div className="field">
          <label htmlFor={questionId} className="field-label">
            Question
          </label>
          <textarea
            id={questionId}
            value={question}
            maxLength={ASK_QUESTION_MAX_CHARS}
            disabled={disabled}
            aria-invalid={questionError !== null}
            aria-describedby={questionError !== null ? errorId : undefined}
            onChange={(event) => onQuestion(event.target.value)}
          />
          {questionError !== null ? (
            <p id={errorId} role="alert" className="field-error">
              {questionError}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
