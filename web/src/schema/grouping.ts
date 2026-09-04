/**
 * Automatic thematic grouping of a schema's tables.
 *
 * Sits BETWEEN the extractor's output and the diagram, on purpose: the
 * generated script only reports raw structure (tables, columns, relations), and
 * the themes are derived here on every render. That way a table an agent adds
 * lands in a group by itself, with no script to regenerate — the script stays
 * valid as the schema grows.
 *
 * Two derivations, both pure and dependency-free:
 *   • WHICH tables belong together — Louvain community detection over the
 *     foreign-key graph (see ./cluster). Deterministic by construction: no PRNG,
 *     fixed visit order, and invariant to the input ordering, which matters
 *     because the panel re-renders every few seconds and groups must not move.
 *   • WHAT each group is called — a prefix → frequent-token → centrality
 *     cascade (see ./group-name), so names come from the data rather than from
 *     any configuration.
 *
 * Both were validated against two branches of a real 51/52-table schema:
 * identical groupings (ARI 1.0) and identical names across versions.
 */
import type { SchemaGraph } from "@/types";
import { clusterSchema, identifyHubs } from "./cluster";
import { nameGroup } from "./group-name";

/** One derived theme. */
export interface SchemaGroup {
  /** Stable id (the cluster's own key). */
  id: string;
  /** Human-readable label derived from the member tables. */
  name: string;
  /** Member table names, sorted. */
  tables: string[];
  /**
   * How confident the naming heuristic is (0–1). A low value flags a group
   * that has no dominant theme, which usually also means it merged two.
   */
  confidence: number;
}

export interface GroupingResult {
  groups: SchemaGroup[];
  /** Table name → its group. */
  byTable: Map<string, SchemaGroup>;
  /**
   * Tables connected to so much of the schema that they belong to no single
   * theme (typically `users`). They stay in their cluster — removing them
   * fragments the graph — but the UI can mark them.
   */
  hubs: Set<string>;
}

export interface GroupingOptions {
  /**
   * Modularity resolution. Higher splits more (smaller, more numerous themes);
   * lower merges. 1.0 is the validated default.
   */
  resolution?: number;
}

/** Derive the themes of a schema. Pure: same graph in, same groups out. */
export function groupSchema(
  graph: SchemaGraph,
  options: GroupingOptions = {},
): GroupingResult {
  const assignment = clusterSchema(graph.entities, graph.relations, {
    resolution: options.resolution ?? 1,
  });
  const byId = new Map<string, string[]>();
  for (const [table, groupId] of toMap(assignment)) {
    const list = byId.get(groupId);
    if (list) list.push(table);
    else byId.set(groupId, [table]);
  }

  const groups: SchemaGroup[] = [];
  for (const [id, tables] of byId) {
    const sorted = [...tables].sort();
    const named = nameGroup(sorted, graph.relations);
    groups.push({ id, name: named.name, tables: sorted, confidence: named.confidence });
  }

  // Biggest first, then alphabetical — a stable order for the legend and the
  // filter, independent of how the clusterer happened to number them.
  groups.sort((a, b) => b.tables.length - a.tables.length || a.name.localeCompare(b.name));

  // Two groups can legitimately derive the same label (e.g. two "Settings"
  // islands). Disambiguate so the filter never shows duplicates.
  const used = new Map<string, number>();
  for (const group of groups) {
    const seen = used.get(group.name) ?? 0;
    used.set(group.name, seen + 1);
    if (seen > 0) group.name = `${group.name} (${seen + 1})`;
  }

  const byTable = new Map<string, SchemaGroup>();
  for (const group of groups) {
    for (const table of group.tables) byTable.set(table, group);
  }

  return { groups, byTable, hubs: new Set(identifyHubs(graph.entities, graph.relations)) };
}

/** The clusterer may return a Map or a plain record; normalize it. */
function toMap(value: unknown): Map<string, string> {
  if (value instanceof Map) return value as Map<string, string>;
  return new Map(Object.entries(value as Record<string, string>));
}
