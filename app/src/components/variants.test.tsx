// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the documented variants of Badge, Alert, Empty and Card: each renders its text and roles, and
// a status is never colour alone (the label is always in the DOM).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { Badge } from "./ui/badge.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "./ui/empty.tsx";

afterEach(cleanup);

describe("the badge", () => {
  // #167-T06
  it.each([
    ["neutral", "Draft"],
    ["info", "Running"],
    ["success", "Passed"],
    ["warning", "Waiting"],
    ["destructive", "Failed"],
  ] as const)(
    "renders the %s status with its label, never colour alone",
    (variant, label) => {
      render(<Badge variant={variant}>{label}</Badge>);

      const badge = screen.getByText(label);
      expect(badge.getAttribute("data-variant")).toBe(variant);
      expect(badge.textContent).toBe(label);
    },
  );
});

describe("the alert", () => {
  // #167-T06
  it.each(["info", "success", "warning", "destructive"] as const)(
    "renders the %s tone with a title and a description",
    (variant) => {
      render(
        <Alert variant={variant}>
          <AlertTitle>Careful</AlertTitle>
          <AlertDescription>Something happened.</AlertDescription>
        </Alert>,
      );

      const alert = screen.getByRole("alert");
      expect(alert.getAttribute("data-slot")).toBe("alert");
      expect(alert.textContent).toContain("Careful");
      expect(alert.textContent).toContain("Something happened.");
    },
  );
});

describe("the empty state", () => {
  // #167-T06
  it("renders a title, one sentence and one action", () => {
    render(
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No projects yet</EmptyTitle>
          <EmptyDescription>
            Sync GitHub to see your repositories.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <button type="button">Sync from GitHub</button>
        </EmptyContent>
      </Empty>,
    );

    expect(screen.getByText("No projects yet")).toBeTruthy();
    expect(
      screen.getByText("Sync GitHub to see your repositories."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sync from GitHub" }),
    ).toBeTruthy();
  });
});

describe("the card", () => {
  // #167-T06
  it("renders its header, title, description, action, content and footer", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Review defaults</CardTitle>
          <CardDescription>Applied to new reviews.</CardDescription>
          <CardAction>
            <button type="button">Reset</button>
          </CardAction>
        </CardHeader>
        <CardContent>Model and behaviour.</CardContent>
        <CardFooter>Last saved today.</CardFooter>
      </Card>,
    );

    expect(screen.getByText("Review defaults")).toBeTruthy();
    expect(screen.getByText("Applied to new reviews.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
    expect(screen.getByText("Model and behaviour.")).toBeTruthy();
    expect(screen.getByText("Last saved today.")).toBeTruthy();
  });
});
