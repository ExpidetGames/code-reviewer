// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The model catalog on the LLM page (#429, ADR 0005, 2.6): the models that workspaces on the key of the instance may
// choose, each with a name, a description, a provider and a real model id that only the operator sees. Empty and
// collapsed until the operator needs it ("Only needed for workspaces whose key mode is managed"), so a self-hoster sees
// no new obligation. The table lists every entry, a retired one too; a row has its actions (edit, release, retire,
// delete, order) and the default of each kind it serves. Every refusal is a stable code that catalog-messages.ts turns
// into a sentence; nothing here throws.
import { useProductIdentity } from "@/product-identity/context";
import {
  CaretDownIcon,
  CaretRightIcon,
  CaretUpIcon,
} from "@phosphor-icons/react/dist/ssr";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "../../components/button.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import type {
  AdminCatalogEntry,
  AdminCatalogView,
} from "../../model-catalog/admin-view.ts";
import {
  CATALOG_KINDS,
  type CatalogStatus,
} from "../../model-catalog/entries.ts";
import type { ProjectReviewKind } from "../../job-kind/job-kind.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import { browserCatalogApi, type CatalogApi } from "./catalog-api.ts";
import { EntryDialog, KIND_LABELS } from "./catalog-entry-dialog.tsx";
import { describeCatalogFailure } from "./catalog-messages.ts";

const STATUS_LABEL: Record<CatalogStatus, string> = {
  draft: "Draft",
  released: "Released",
  retired: "Retired",
};
const STATUS_BADGE = {
  draft: "info",
  released: "success",
  retired: "neutral",
} as const satisfies Record<CatalogStatus, string>;

function projectsText(count: number): string {
  if (count === 0) return "No projects";
  return `${String(count)} ${count === 1 ? "project" : "projects"}`;
}

type Confirm = { action: "retire" | "delete"; entry: AdminCatalogEntry } | null;

type Outcome = { kind: "saved" } | { kind: "failed"; text: string } | null;

export function ModelCatalogSection({
  catalog,
  api = browserCatalogApi,
}: {
  catalog: AdminCatalogView;
  /** Only tests pass this. */
  api?: CatalogApi;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const headingId = useId();
  const [open, setOpen] = useState(catalog.entries.length > 0);
  const [editing, setEditing] = useState<AdminCatalogEntry | "new" | null>(
    null,
  );
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const providerLabel = (id: string) =>
    catalog.providers.find((provider) => provider.id === id)?.label ?? id;
  /** Whether the entry is the instance default of a kind: projects without a choice of their own fall back to it. */
  const isDefault = (entry: AdminCatalogEntry) =>
    CATALOG_KINDS.some((kind) => catalog.defaults[kind] === entry.id);
  const defaultName = (kind: ProjectReviewKind) =>
    catalog.entries.find((entry) => entry.id === catalog.defaults[kind])
      ?.name ?? "none";

  /** Runs one change, shows its result and reloads the page's data after a success. */
  async function run(call: () => Promise<RequestResult<unknown>>) {
    setBusy(true);
    setOutcome(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      setOutcome({
        kind: "failed",
        text: describeCatalogFailure(product, result.code),
      });
      return;
    }
    setOutcome({ kind: "saved" });
    router.refresh();
  }

  function toggleDefault(entry: AdminCatalogEntry, kind: ProjectReviewKind) {
    const next = {
      ...catalog.defaults,
      [kind]: catalog.defaults[kind] === entry.id ? null : entry.id,
    };
    void run(() => api.setDefaults(next));
  }

  /** Moves the entry one place: the new order of all entries goes to the server in one request. */
  function move(index: number, by: -1 | 1) {
    const order = [...catalog.entries];
    const [moved] = order.splice(index, 1);
    if (moved === undefined) return;
    order.splice(index + by, 0, moved);
    void run(() => api.reorder(order.map((entry) => entry.id)));
  }

  function decide() {
    const pending = confirm;
    setConfirm(null);
    if (pending === null) return;
    void run(() =>
      pending.action === "retire"
        ? api.retire(pending.entry.id)
        : api.remove(pending.entry.id),
    );
  }

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <Collapsible open={open} onOpenChange={setOpen}>
          <CardHeader>
            <CardTitle>
              <h2
                id={headingId}
                className="text-lg font-semibold tracking-tight"
              >
                Model catalog
              </h2>
            </CardTitle>
            <CardDescription>
              Only needed for workspaces whose key mode is managed.
            </CardDescription>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="w-fit"
                aria-label={open ? "Hide model catalog" : "Show model catalog"}
              >
                {open ? (
                  <CaretDownIcon aria-hidden="true" />
                ) : (
                  <CaretRightIcon aria-hidden="true" />
                )}
                {open ? "Hide" : "Show"}
              </Button>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                The models that workspaces billed via {product.name} may choose.
                Members see the name, the description and the provider of a
                released entry, never the model id. A retired entry stays listed
                here.
              </p>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-1 text-sm">
                  <p>Default for Diff: {defaultName("diff")}</p>
                  <p>Default for Dynamic: {defaultName("dynamic")}</p>
                </div>
                <Button onClick={() => setEditing("new")} disabled={busy}>
                  Add model
                </Button>
              </div>
              {outcome?.kind === "failed" ? (
                <Alert variant="destructive">
                  <AlertDescription>{outcome.text}</AlertDescription>
                </Alert>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  {outcome?.kind === "saved" ? "Saved." : null}
                </p>
              )}
              {catalog.entries.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No models yet. Add one, check it with the provider and release
                  it: members of managed workspaces see only the released
                  entries.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead>Serves</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Used by</TableHead>
                      <TableHead>Default</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {catalog.entries.map((entry, index) => (
                      <TableRow key={entry.id}>
                        <TableCell className="whitespace-normal">
                          <div className="font-medium">{entry.name}</div>
                          {entry.description === null ? null : (
                            <div className="text-xs text-muted-foreground">
                              {entry.description}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>{providerLabel(entry.provider)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {entry.modelId}
                        </TableCell>
                        <TableCell>
                          {entry.kinds
                            .map((kind) => KIND_LABELS[kind])
                            .join(", ")}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_BADGE[entry.status]}>
                            {STATUS_LABEL[entry.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <div>{projectsText(entry.usedByProjects)}</div>
                          {isDefault(entry) ? (
                            <div className="text-xs text-muted-foreground">
                              Includes projects on the default
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <div className="flex flex-wrap gap-1">
                            {entry.status !== "released"
                              ? null
                              : entry.kinds.map((kind) => (
                                  <Button
                                    key={kind}
                                    size="sm"
                                    variant={
                                      catalog.defaults[kind] === entry.id
                                        ? "primary"
                                        : "secondary"
                                    }
                                    aria-pressed={
                                      catalog.defaults[kind] === entry.id
                                    }
                                    aria-label={`${entry.name}: default for ${KIND_LABELS[kind]}`}
                                    disabled={busy}
                                    onClick={() => toggleDefault(entry, kind)}
                                  >
                                    Default for {KIND_LABELS[kind]}
                                  </Button>
                                ))}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <div className="flex flex-wrap items-center gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Move ${entry.name} up`}
                              disabled={busy || index === 0}
                              onClick={() => move(index, -1)}
                            >
                              <CaretUpIcon aria-hidden="true" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Move ${entry.name} down`}
                              disabled={
                                busy || index === catalog.entries.length - 1
                              }
                              onClick={() => move(index, 1)}
                            >
                              <CaretDownIcon aria-hidden="true" />
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              aria-label={`Edit ${entry.name}`}
                              disabled={busy}
                              onClick={() => setEditing(entry)}
                            >
                              Edit
                            </Button>
                            {entry.status === "released" ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                aria-label={`Retire ${entry.name}`}
                                disabled={busy}
                                onClick={() =>
                                  setConfirm({ action: "retire", entry })
                                }
                              >
                                Retire
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="secondary"
                                aria-label={`Release ${entry.name}`}
                                disabled={busy}
                                onClick={() =>
                                  void run(() => api.release(entry.id))
                                }
                              >
                                Release
                              </Button>
                            )}
                            {entry.status === "draft" ? (
                              <Button
                                size="sm"
                                variant="destructive"
                                aria-label={`Delete ${entry.name}`}
                                disabled={busy}
                                onClick={() =>
                                  setConfirm({ action: "delete", entry })
                                }
                              >
                                Delete
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      {editing === null ? null : (
        <EntryDialog
          key={editing === "new" ? "new" : editing.id}
          entry={editing === "new" ? null : editing}
          isDefault={editing !== "new" && isDefault(editing)}
          providers={catalog.providers}
          api={api}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setOutcome({ kind: "saved" });
            router.refresh();
          }}
        />
      )}

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(next) => (next ? undefined : setConfirm(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === "delete" ? "Delete" : "Retire"}{" "}
              {confirm?.entry.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.action === "delete"
                ? "A draft is deleted for good."
                : `Members can no longer choose it. ${projectsText(confirm?.entry.usedByProjects ?? 0)} use${(confirm?.entry.usedByProjects ?? 0) === 1 ? "s" : ""} it now; their reviews stop with a notice until another model is chosen. You can release it again.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={decide}>
              {confirm?.action === "delete" ? "Delete" : "Retire"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
