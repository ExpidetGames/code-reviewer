// SPDX-License-Identifier: LicenseRef-Proprietary

// Lets a test run something between two statements of a transaction: a Kysely plugin that awaits a callback after a query has
// answered, before the caller sees the answer. The callback does its work on another connection of the same database (a
// second admin saving, a second request inserting a row), so it relies on connections that run in parallel; a callback that
// used the transaction's own connection would wait for the transaction it interrupts.
import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from "kysely";

export type QueryInfo = {
  /** `select`, `insert`, `update`, `delete` or the node kind of anything else. */
  kind: string;
  /** The table the statement reads or writes, when it is one plain table. */
  table: string | undefined;
};

type Named = {
  kind: string;
  node?: Named;
  table?: Named;
  identifier?: Named;
  name?: string;
};

function nameOf(node: Named | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.kind === "AliasNode") return nameOf(node.node);
  if (node.kind === "TableNode") return nameOf(node.table);
  if (node.kind === "SchemableIdentifierNode") return nameOf(node.identifier);
  return node.kind === "IdentifierNode" ? node.name : undefined;
}

export function describeQuery(node: RootOperationNode): QueryInfo {
  const any = node as unknown as {
    kind: string;
    from?: { froms: Named[] };
    into?: Named;
    table?: Named;
  };
  switch (any.kind) {
    case "SelectQueryNode":
      return { kind: "select", table: nameOf(any.from?.froms[0]) };
    case "InsertQueryNode":
      return { kind: "insert", table: nameOf(any.into) };
    case "UpdateQueryNode":
      return { kind: "update", table: nameOf(any.table) };
    case "DeleteQueryNode":
      return { kind: "delete", table: nameOf(any.from?.froms[0]) };
    default:
      return { kind: any.kind, table: undefined };
  }
}

/** A plugin that awaits `after(query)` once each query has answered. Use it with `db.withPlugin(...)`. */
export function afterQueryPlugin(
  after: (query: QueryInfo) => Promise<void>,
): KyselyPlugin {
  const queries = new WeakMap<object, RootOperationNode>();
  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      queries.set(args.queryId, args.node);
      return args.node;
    },
    async transformResult(
      args: PluginTransformResultArgs,
    ): Promise<QueryResult<UnknownRow>> {
      const node = queries.get(args.queryId);
      if (node !== undefined) await after(describeQuery(node));
      return args.result;
    },
  };
}
