/**
 * Turns a {@link SchemaGraph} + its {@link SchemaDiff} into a Mermaid diagram,
 * plus the lookup tables needed to paint the result.
 *
 * Two grammars, because neither does everything:
 *   • `erDiagram` — the default. Crow's-foot cardinality, but Mermaid's ER
 *     grammar has NO concept of clusters, so it cannot group tables.
 *   • `classDiagram` — used for the grouped view, because its `namespace`
 *     renders as a real cluster box. The cost is the cardinality notation.
 *
 * Mermaid has no per-element styling in either grammar, so highlighting is done
 * by post-processing the rendered SVG. That is reliable because Mermaid emits
 * predictable handles, each verified in a browser against the version this app
 * ships:
 *   • ER entities → `g.node` id `<graphId>-entity-<name>-<i>`
 *   • ER relations → `path.relationshipLine`, trailing `_<i>` = declaration
 *     index, ZERO-based
 *   • class entities → `g.node` id `<graphId>-classId-<name>-<i>`
 *   • class relations → `path.relation`, trailing `_<i>` = declaration index,
 *     ONE-based
 * {@link applyHighlights} relies on exactly those facts, and ignores anything
 * it does not recognize rather than risk colouring the wrong element.
 *
 * Relations are drawn child → parent: the entity holding the foreign key is on
 * the "many" end, so a glance shows which side owns the reference.
 */
import type { SchemaDiff, SchemaGraph, SchemaRelation } from "@/types";
import type { SchemaGroup } from "./grouping";

/** Visual state of an element in the diagram. */
export type HighlightKind = "added" | "changed" | "removed" | "pending";

export interface DiagramOptions {
  /** Render each entity's columns, not just its name. */
  showFields: boolean;
  /** Restrict to what this task touched, plus one hop of context. */
  onlyChanged: boolean;
  /**
   * Draw tables inside boxes per theme. Mermaid's ER grammar has no notion of
   * clusters, so this switches to a class diagram, whose `namespace` does —
   * trading the ER crow's-foot cardinality for the grouping.
   */
  grouped?: boolean;
  /** Table → theme, required when `grouped` is set. */
  groupByTable?: Map<string, SchemaGroup>;
  /** Show only this theme (and the tables it links to). Null = all. */
  onlyGroupId?: string | null;
}

export interface DiagramDefinition {
  /** The Mermaid source to render. */
  code: string;
  /** Render-name → highlight, for entities that have one. */
  entityHighlights: Map<string, HighlightKind>;
  /** Edge index (declaration order) → highlight. */
  relationHighlights: Map<number, HighlightKind>;
  /**
   * Render-name → highlight for an entity's SELF relation. Mermaid draws a
   * self-reference as a separate `…-cyclic-special-…` path set that carries no
   * edge index, so those are matched by entity instead. Only populated when the
   * entity has exactly one self relation; with two there is no way to tell the
   * paths apart, and guessing would paint the wrong one.
   */
  selfRelationHighlights: Map<string, HighlightKind>;
  /** Render-name → original entity name (they differ only for odd names). */
  originalNames: Map<string, string>;
  /** Entities present in the graph but filtered out of this view. */
  hiddenEntities: number;
  /** True when there is nothing to draw. */
  empty: boolean;
  /**
   * Which grammar produced `code`. The two differ in how Mermaid names the
   * SVG elements, so {@link applyHighlights} needs to know.
   */
  kind: "er" | "class";
}

/** Stable key for a relation, matching the server's `relationKey`. */
export const relationKey = (r: SchemaRelation): string =>
  `${r.from}.${r.fromField}->${r.to}`;

/**
 * Mermaid identifiers accept `[A-Za-z0-9_]`; anything else would break the
 * parse, so it is replaced. Rails table names never need this, but a future
 * dialect might.
 */
const renderName = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, "_");

/** Las líneas de entidad de un diagrama, con lo que hace falta para pintarlas. */
interface RenderedEntities {
  lines: string[];
  entityHighlights: Map<string, HighlightKind>;
  originalNames: Map<string, string>;
}

/**
 * Emite el bloque de cada entidad visible — en modo agrupado, dentro del
 * `namespace` de su tema, tema por tema para que cada caja quede contigua;
 * en modo ER, en el orden propio del grafo.
 */
function renderEntities(
  graph: SchemaGraph,
  visible: Set<string>,
  diff: SchemaDiff | undefined,
  options: DiagramOptions,
  grouped: boolean,
): RenderedEntities {
  const lines: string[] = [];
  const entityHighlights = new Map<string, HighlightKind>();
  const originalNames = new Map<string, string>();

  // In a class diagram every table is wrapped in its theme's namespace, which
  // is what Mermaid turns into a cluster box.
  const openNamespace = (name: string | null): void => {
    if (name !== null) lines.push(`  namespace ${namespaceId(name)} {`);
  };

  for (const [groupName, entities] of entityBuckets(graph, visible, options, grouped)) {
    openNamespace(groupName);
    const indent = groupName === null ? "  " : "    ";
    for (const entity of entities) {
      const id = renderName(entity.name);
      originalNames.set(id, entity.name);

      const highlight = entityHighlight(entity.name, entity.pending, diff);
      if (highlight) entityHighlights.set(id, highlight);

      const open = grouped ? `${indent}class ${id} {` : `${indent}${id} {`;
      if (!options.showFields) {
        // An entity with no member block still renders as a labelled box.
        lines.push(open, `${indent}}`);
        continue;
      }

      lines.push(open);
      for (const field of entity.fields) {
        const keys: string[] = [];
        if (field.primaryKey) keys.push("PK");
        if (graph.relations.some((r) => r.from === entity.name && r.fromField === field.name)) {
          keys.push("FK");
        }
        const note = fieldNote(entity.name, field.name, field.pending, diff);
        const type = renderName(field.type || "text");
        const fieldName = renderName(field.name);
        lines.push(
          grouped
            ? // Class members carry no comment slot, so a change marker is
              // appended to the name instead.
              `${indent}  +${type} ${fieldName}${keys.length ? ` ${keys.join(",")}` : ""}` +
                `${note ? ` << ${note} >>` : ""}`
            : `${indent}  ${type} ${fieldName}` +
                `${keys.length ? ` ${keys.join(",")}` : ""}${note ? ` "${note}"` : ""}`,
        );
      }
      lines.push(`${indent}}`);
    }
    if (groupName !== null) lines.push("  }");
  }

  return { lines, entityHighlights, originalNames };
}

/** Las líneas de relación de un diagrama, con lo que hace falta para pintarlas. */
interface RenderedRelations {
  lines: string[];
  relationHighlights: Map<number, HighlightKind>;
  selfRelationHighlights: Map<string, HighlightKind>;
}

/**
 * Emite las relaciones entre entidades visibles, en el orden de declaración
 * del grafo — ese orden ES el índice de arista con el que `applyHighlights`
 * encuentra cada `path` en el SVG, así que no se puede reordenar.
 */
function renderRelations(
  graph: SchemaGraph,
  visible: Set<string>,
  diff: SchemaDiff | undefined,
  grouped: boolean,
): RenderedRelations {
  const lines: string[] = [];
  const relationHighlights = new Map<number, HighlightKind>();
  const selfRelationHighlights = new Map<string, HighlightKind>();
  const selfRelationCount = new Map<string, number>();

  let edgeIndex = 0;
  for (const relation of graph.relations) {
    if (!visible.has(relation.from) || !visible.has(relation.to)) continue;

    const highlight = relationHighlight(relation, diff);
    if (highlight) relationHighlights.set(edgeIndex, highlight);

    if (relation.from === relation.to) {
      const id = renderName(relation.from);
      selfRelationCount.set(id, (selfRelationCount.get(id) ?? 0) + 1);
      if (highlight) selfRelationHighlights.set(id, highlight);
    }

    if (grouped) {
      // No cardinality in a class diagram: the arrow still points child → parent.
      lines.push(
        `  ${renderName(relation.from)} --> ${renderName(relation.to)} : ${relation.fromField}`,
      );
    } else {
      // Optional FK → "zero or one" parent; required FK → "exactly one".
      const parentEnd = isOptional(graph, relation) ? "o|" : "||";
      lines.push(
        `  ${renderName(relation.from)} }o--${parentEnd} ${renderName(relation.to)} : "${relation.fromField}"`,
      );
    }
    edgeIndex++;
  }

  // Ambiguous when an entity references itself more than once: drop those
  // rather than highlight an arbitrary one of the identical path sets.
  for (const [id, count] of selfRelationCount) {
    if (count > 1) selfRelationHighlights.delete(id);
  }

  return { lines, relationHighlights, selfRelationHighlights };
}

export function buildDiagram(
  graph: SchemaGraph,
  diff: SchemaDiff | undefined,
  options: DiagramOptions,
): DiagramDefinition {
  let visible = selectEntities(graph, diff, options.onlyChanged);
  if (options.onlyGroupId && options.groupByTable) {
    visible = restrictToGroup(graph, visible, options.groupByTable, options.onlyGroupId);
  }
  const hiddenEntities = graph.entities.length - visible.size;
  const grouped = options.grouped === true && options.groupByTable !== undefined;

  const entities = renderEntities(graph, visible, diff, options, grouped);
  // Relations are emitted last so their edge indices are contiguous and
  // predictable for the SVG pass.
  const relations = renderRelations(graph, visible, diff, grouped);

  return {
    code: [grouped ? "classDiagram" : "erDiagram", ...entities.lines, ...relations.lines].join("\n"),
    entityHighlights: entities.entityHighlights,
    relationHighlights: relations.relationHighlights,
    selfRelationHighlights: relations.selfRelationHighlights,
    originalNames: entities.originalNames,
    hiddenEntities,
    empty: visible.size === 0,
    kind: grouped ? "class" : "er",
  };
}

/**
 * Entities to emit, bucketed by theme name (null = no namespace wrapper).
 * Ungrouped mode yields a single null bucket in the graph's own order.
 */
function entityBuckets(
  graph: SchemaGraph,
  visible: Set<string>,
  options: DiagramOptions,
  grouped: boolean,
): Array<[string | null, SchemaGraph["entities"]]> {
  const present = graph.entities.filter((e) => visible.has(e.name));
  if (!grouped || !options.groupByTable) return [[null, present]];

  const buckets = new Map<string | null, SchemaGraph["entities"]>();
  for (const entity of present) {
    const name = options.groupByTable.get(entity.name)?.name ?? null;
    const bucket = buckets.get(name);
    if (bucket) bucket.push(entity);
    else buckets.set(name, [entity]);
  }
  // Ungrouped tables last, so they sit outside every box.
  return [...buckets.entries()].sort((a, b) =>
    a[0] === null ? 1 : b[0] === null ? -1 : a[0].localeCompare(b[0]),
  );
}

/** Keep one theme plus whatever it links to, so its edges have both ends. */
function restrictToGroup(
  graph: SchemaGraph,
  visible: Set<string>,
  groupByTable: Map<string, SchemaGroup>,
  groupId: string,
): Set<string> {
  const core = new Set(
    [...visible].filter((t) => groupByTable.get(t)?.id === groupId),
  );
  if (core.size === 0) return core;
  const withNeighbors = new Set(core);
  for (const relation of graph.relations) {
    if (core.has(relation.from) && visible.has(relation.to)) withNeighbors.add(relation.to);
    if (core.has(relation.to) && visible.has(relation.from)) withNeighbors.add(relation.from);
  }
  return withNeighbors;
}

/**
 * Namespace labels must be bare identifiers, so spaces become underscores —
 * "Service Types" renders as `Service_Types` inside the cluster box.
 */
const namespaceId = (name: string): string => renderName(name.replace(/\s+/g, "_"));

/** True when the referencing column is nullable (so the parent is optional). */
function isOptional(graph: SchemaGraph, relation: SchemaRelation): boolean {
  const entity = graph.entities.find((e) => e.name === relation.from);
  const field = entity?.fields.find((f) => f.name === relation.fromField);
  return field ? field.nullable : true;
}

function entityHighlight(
  name: string,
  pending: boolean,
  diff: SchemaDiff | undefined,
): HighlightKind | null {
  const change = diff?.entities[name];
  if (change === "added") return "added";
  if (pending) return "pending";
  if (change === "changed") return "changed";
  return null;
}

function relationHighlight(
  relation: SchemaRelation,
  diff: SchemaDiff | undefined,
): HighlightKind | null {
  const change = diff?.relations[relationKey(relation)];
  if (change === "added") return "added";
  if (relation.pending) return "pending";
  if (change === "changed") return "changed";
  return null;
}

/** Short marker rendered in a column's comment slot. */
function fieldNote(
  entity: string,
  field: string,
  pending: boolean,
  diff: SchemaDiff | undefined,
): string | null {
  const change = diff?.fields[`${entity}.${field}`];
  if (change === "added") return pending ? "nuevo · sin migrar" : "nuevo";
  if (change === "changed") return "modificado";
  if (pending) return "sin migrar";
  return null;
}

/**
 * Which entities to draw. Unfiltered that is all of them; in "only changed"
 * mode it is everything this task touched plus one hop of context, so a new
 * relation is always shown attached to the table it points at.
 */
function selectEntities(
  graph: SchemaGraph,
  diff: SchemaDiff | undefined,
  onlyChanged: boolean,
): Set<string> {
  const all = new Set(graph.entities.map((e) => e.name));
  if (!onlyChanged) return all;

  const seeds = new Set<string>();
  for (const entity of graph.entities) {
    if (entity.pending || diff?.entities[entity.name]) seeds.add(entity.name);
  }
  for (const relation of graph.relations) {
    if (relation.pending || diff?.relations[relationKey(relation)]) {
      seeds.add(relation.from);
      seeds.add(relation.to);
    }
  }
  for (const key of Object.keys(diff?.fields ?? {})) {
    const entity = key.slice(0, key.lastIndexOf("."));
    if (all.has(entity)) seeds.add(entity);
  }

  if (seeds.size === 0) return new Set();

  // One hop out, so every seed's relations have both ends drawn.
  const withNeighbors = new Set(seeds);
  for (const relation of graph.relations) {
    if (seeds.has(relation.from)) withNeighbors.add(relation.to);
    if (seeds.has(relation.to)) withNeighbors.add(relation.from);
  }
  return new Set([...withNeighbors].filter((n) => all.has(n)));
}

/**
 * Tag the rendered SVG so CSS can colour it. Mermaid gives entities an id of
 * `<graphId>-entity-<name>-<i>` and relations a trailing `_<i>` matching the
 * declaration order used above; both are matched defensively, so a Mermaid
 * change degrades to "no highlight" rather than a crash.
 */
export function applyHighlights(
  svg: SVGElement,
  definition: DiagramDefinition,
  graphId: string,
): void {
  // The two grammars name their elements differently; everything below is
  // keyed off `kind` so neither can be matched with the other's rules.
  const isClass = definition.kind === "class";
  const nodePrefix = `${graphId}-${isClass ? "classId" : "entity"}-`;
  const edgeSelector = isClass ? "path.relation" : "path.relationshipLine";
  // Class-diagram edges are numbered from 1, ER edges from 0.
  const indexOffset = isClass ? 1 : 0;

  highlightEntityNodes(svg, definition, nodePrefix);
  highlightRelationPaths(svg, definition, edgeSelector, indexOffset);
}

/**
 * Entity boxes: the render-name sits between `<graphId>-entity-`/`-classId-`
 * and Mermaid's trailing `-<i>`. An id that doesn't start with the prefix
 * belongs to another diagram on the page and is left alone.
 */
function highlightEntityNodes(
  svg: SVGElement,
  definition: DiagramDefinition,
  nodePrefix: string,
): void {
  for (const node of Array.from(svg.querySelectorAll<SVGGElement>("g.node"))) {
    if (!node.id.startsWith(nodePrefix)) continue;
    const name = node.id.slice(nodePrefix.length).replace(/-\d+$/, "");
    const highlight = definition.entityHighlights.get(name);
    if (highlight) node.classList.add(`ck-er--${highlight}`);
  }
}

/**
 * Relation paths: a self-reference is matched by entity name (its paths carry
 * no edge index), everything else by the trailing `_<i>` declaration index.
 */
function highlightRelationPaths(
  svg: SVGElement,
  definition: DiagramDefinition,
  edgeSelector: string,
  indexOffset: number,
): void {
  for (const edge of Array.from(svg.querySelectorAll<SVGPathElement>(edgeSelector))) {
    // A self-reference: `<graphId>-entity-<name>-<i>-cyclic-special-<part>`,
    // drawn as several paths with no edge index.
    const cyclic = /-(?:entity|classId)-([A-Za-z0-9_]+)-\d+-cyclic-special/.exec(edge.id);
    if (cyclic) {
      const highlight = definition.selfRelationHighlights.get(cyclic[1]);
      if (highlight) edge.classList.add(`ck-er--${highlight}`);
      continue;
    }

    // A normal edge: the trailing `_<i>` is its declaration index. Anything
    // else is left alone — an unrecognized id means no highlight, never a
    // highlight on the wrong edge.
    const parsed = /_(\d+)$/.exec(edge.id);
    if (!parsed) continue;
    const highlight = definition.relationHighlights.get(Number(parsed[1]) - indexOffset);
    if (highlight) edge.classList.add(`ck-er--${highlight}`);
  }
}

