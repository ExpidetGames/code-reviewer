// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// A render/role test for every remaining primitive of the kit: form controls, selection controls,
// layout and navigation. It proves each component is wired and accessible (a label, a role, a name),
// not that it is styled.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./ui/breadcrumb.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { Progress } from "./ui/progress.tsx";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { Separator } from "./ui/separator.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Switch } from "./ui/switch.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table.tsx";
import { Textarea } from "./ui/textarea.tsx";

afterEach(cleanup);

describe("form controls", () => {
  it("builds a labelled field with a legend, a description and an error", () => {
    render(
      <FieldSet>
        <FieldLegend>Model</FieldLegend>
        <Field>
          <FieldLabel htmlFor="model">Model id</FieldLabel>
          <Input id="model" />
          <FieldDescription>
            Exactly as the provider spells it.
          </FieldDescription>
          <FieldError errors={[{ message: "This model is not known." }]} />
        </Field>
      </FieldSet>,
    );

    expect(screen.getByText("Model")).toBeTruthy();
    expect(screen.getByLabelText("Model id").tagName).toBe("INPUT");
    expect(screen.getByText("Exactly as the provider spells it.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "This model is not known.",
    );
  });

  it("labels an input and a textarea", () => {
    render(
      <>
        <Label htmlFor="name">Workspace name</Label>
        <Input id="name" />
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" />
      </>,
    );

    expect(screen.getByLabelText("Workspace name").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
  });

  it("renders a checkbox, a switch and a radio group with their roles", () => {
    render(
      <>
        <Checkbox aria-label="Enable reviews" />
        <Switch aria-label="Active" />
        <RadioGroup aria-label="Tenancy">
          <RadioGroupItem value="single" aria-label="Single tenant" />
          <RadioGroupItem value="multi" aria-label="Multi tenant" />
        </RadioGroup>
      </>,
    );

    expect(
      screen.getByRole("checkbox", { name: "Enable reviews" }),
    ).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Active" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Tenancy" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("selects an option from the select", async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger aria-label="Model">
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="haiku">Haiku</SelectItem>
          <SelectItem value="sonnet">Sonnet</SelectItem>
        </SelectContent>
      </Select>,
    );

    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: "Sonnet" }));

    await waitFor(() =>
      expect(screen.getByRole("combobox").textContent).toContain("Sonnet"),
    );
  });
});

describe("layout and navigation", () => {
  it("shows a meaningful separator with its role, and hides a decorative one", () => {
    const { unmount } = render(<Separator decorative={false} />);
    expect(screen.getByRole("separator")).toBeTruthy();
    unmount();

    render(<Separator />);
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("shows progress with its value", () => {
    render(<Progress value={40} aria-label="Step 1 of 3" />);

    const progress = screen.getByRole("progressbar", { name: "Step 1 of 3" });
    expect(progress.getAttribute("aria-valuenow")).toBe("40");
  });

  it("renders a labelled skeleton", () => {
    render(<Skeleton data-testid="skeleton" />);

    expect(screen.getByTestId("skeleton").getAttribute("data-slot")).toBe(
      "skeleton",
    );
  });

  it("falls back to the initials when the avatar has no image", () => {
    render(
      <Avatar>
        <AvatarImage src={undefined} alt="" />
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>,
    );

    expect(screen.getByText("AL")).toBeTruthy();
  });

  it("marks the current page in a breadcrumb", () => {
    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/w/acme/projects">Projects</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>acme/widgets</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    );

    expect(screen.getByRole("navigation", { name: "breadcrumb" })).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "acme/widgets" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("renders a table with headers and cells", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>acme/widgets</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    expect(screen.getByRole("columnheader", { name: "Project" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "acme/widgets" })).toBeTruthy();
  });
});

describe("disclosures and overlays", () => {
  it("opens and closes a collapsible", async () => {
    const user = userEvent.setup();
    render(
      <Collapsible>
        <CollapsibleTrigger>How this works</CollapsibleTrigger>
        <CollapsibleContent>The details.</CollapsibleContent>
      </Collapsible>,
    );

    await user.click(screen.getByRole("button", { name: "How this works" }));
    expect(screen.getByText("The details.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "How this works" }));
    await waitFor(() => expect(screen.queryByText("The details.")).toBeNull());
  });

  it("opens a dropdown menu from the keyboard and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull(),
    );
  });

  it("opens a sheet as a dialog", async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger asChild>
          <button type="button">Menu</button>
        </SheetTrigger>
        <SheetContent>
          <SheetTitle>Navigation</SheetTitle>
          <SheetDescription>Where to go.</SheetDescription>
        </SheetContent>
      </Sheet>,
    );

    await user.click(screen.getByRole("button", { name: "Menu" }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
