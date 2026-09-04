/**
 * Diagram-definition tests.
 *
 * These cover the mapping between our schema model and the Mermaid source,
 * plus the bookkeeping `applyHighlights` depends on. The self-reference case is
 * here because Mermaid renders those as `…-cyclic-special-…` paths that carry
 * NO edge index: without special handling a self relation cannot be matched by
 * index, and matching it positionally would colour an unrelated edge.
 */
import { describe, expect, it } from "vitest";

import { buildDiagram } from "./mermaid-er";
import type { SchemaDiff, SchemaGraph } from "@shared/types";

/** A field spec: `name`, or `name!` for NOT NULL. */
const entity = (name: string, fields: string[], pending = false) => ({
  name,
  pending,
  sourceFile: "db/schema.rb",
  sourceLine: 1,
  fields: fields.map((spec) => {
    const required = spec.endsWith("!");
    const fieldName = required ? spec.slice(0, -1) : spec;
    return {
      name: fieldName,
      type: fieldName === "id" || fieldName.endsWith("_id") ? "bigint" : "string",
      nullable: !required && fieldName !== "id",
      primaryKey: fieldName === "id",
      pending: false,
    };
  }),
});

const relation = (
  from: string,
  fromField: string,
  to: string,
  pending = false,
) => ({
  from,
  fromField,
  to,
  onDelete: null,
  sourceFile: "db/schema.rb",
  sourceLine: 1,
  pending,
});

const GRAPH: SchemaGraph = {
  repoName: "backend",
  dialect: "rails",
  sourceFiles: ["db/schema.rb"],
  entities: [
    // team_id is nullable: an optional parent. user_id is NOT NULL: required.
    entity("users", ["id", "email", "team_id"]),
    entity("comments", ["id", "body", "user_id!", "parent_comment_id"]),
    entity("teams", ["id", "name"], true),
    entity("unrelated", ["id"]),
  ],
  relations: [
    relation("comments", "user_id", "users"),
    relation("comments", "parent_comment_id", "comments"),
    relation("users", "team_id", "teams", true),
  ],
};

const DIFF: SchemaDiff = {
  baseBranch: "main",
  entities: { teams: "added", comments: "changed" },
  fields: { "teams.name": "added" },
  relations: { "users.team_id->teams": "added" },
};

const OPTIONS = { showFields: true, onlyChanged: false };

describe("buildDiagram", () => {
  const def = buildDiagram(GRAPH, DIFF, OPTIONS);

  it("emits an erDiagram with every entity and relation", () => {
    expect(def.code.startsWith("erDiagram")).toBe(true);
    for (const name of ["users", "comments", "teams", "unrelated"]) {
      expect(def.code).toContain(`  ${name} {`);
    }
    expect(def.empty).toBe(false);
  });

  it("draws relations from child to parent, labelled with the FK column", () => {
    // `}o--||` puts the many end on the child, which is what holds the key.
    expect(def.code).toContain('comments }o--|| users : "user_id"');
    // A nullable FK gets the optional parent end.
    expect(def.code).toContain('users }o--o| teams : "team_id"');
  });

  it("marks entity state, preferring added over pending over changed", () => {
    expect(def.entityHighlights.get("teams")).toBe("added");
    expect(def.entityHighlights.get("comments")).toBe("changed");
    expect(def.entityHighlights.get("users")).toBeUndefined();
  });

  it("keys relation highlights by declaration index", () => {
    // Relations are emitted in graph order: 0 user_id, 1 self, 2 team_id.
    expect(def.relationHighlights.get(2)).toBe("added");
    expect(def.relationHighlights.get(0)).toBeUndefined();
  });

  it("tracks a self relation by entity, since its paths carry no index", () => {
    const selfDiff: SchemaDiff = {
      ...DIFF,
      relations: { "comments.parent_comment_id->comments": "added" },
    };
    const withSelf = buildDiagram(GRAPH, selfDiff, OPTIONS);
    expect(withSelf.selfRelationHighlights.get("comments")).toBe("added");
  });

  it("refuses to guess when an entity references itself twice", () => {
    const ambiguous: SchemaGraph = {
      ...GRAPH,
      relations: [
        ...GRAPH.relations,
        relation("comments", "root_comment_id", "comments"),
      ],
    };
    const def2 = buildDiagram(
      ambiguous,
      { ...DIFF, relations: { "comments.parent_comment_id->comments": "added" } },
      OPTIONS,
    );
    // Two identical path sets: highlighting either one could be the wrong one.
    expect(def2.selfRelationHighlights.has("comments")).toBe(false);
  });

  it("omits attributes when fields are hidden", () => {
    const compact = buildDiagram(GRAPH, DIFF, { ...OPTIONS, showFields: false });
    expect(compact.code).toContain("  users {");
    expect(compact.code).not.toContain("email");
    // Relations survive the compact view.
    expect(compact.code).toContain('comments }o--|| users : "user_id"');
  });

  it("annotates changed columns in the comment slot", () => {
    expect(def.code).toContain('string name "nuevo"');
  });

  it("only-changed mode keeps what moved plus one hop of context", () => {
    const focused = buildDiagram(GRAPH, DIFF, { ...OPTIONS, onlyChanged: true });
    // teams (added) and comments (changed) are seeds; users is one hop away
    // via the new relation, so the edge has both ends.
    expect(focused.code).toContain("  teams {");
    expect(focused.code).toContain("  comments {");
    expect(focused.code).toContain("  users {");
    // Nothing links `unrelated` to any of them.
    expect(focused.code).not.toContain("  unrelated {");
    expect(focused.hiddenEntities).toBe(1);
  });

  it("reports empty when nothing changed in only-changed mode", () => {
    const quiet = buildDiagram(
      {
        ...GRAPH,
        // Nothing pending and nothing in the diff ⇒ nothing to focus on.
        entities: GRAPH.entities.map((e) => ({ ...e, pending: false })),
        relations: GRAPH.relations.map((r) => ({ ...r, pending: false })),
      },
      { baseBranch: "main", entities: {}, fields: {}, relations: {} },
      { ...OPTIONS, onlyChanged: true },
    );
    expect(quiet.empty).toBe(true);
  });

  it("works with no diff at all (a task with no base branch)", () => {
    const plain = buildDiagram(GRAPH, undefined, OPTIONS);
    expect(plain.entityHighlights.get("teams")).toBe("pending");
    expect(plain.relationHighlights.get(2)).toBe("pending");
  });
});

describe("modo agrupado (classDiagram)", () => {
  const groups = new Map([
    ["users", { id: "g1", name: "Cuentas", tables: ["users", "teams"], confidence: 1 }],
    ["teams", { id: "g1", name: "Cuentas", tables: ["users", "teams"], confidence: 1 }],
    ["comments", { id: "g2", name: "Contenido", tables: ["comments"], confidence: 1 }],
  ]);
  const opts = { ...OPTIONS, grouped: true, groupByTable: groups };

  it("emite un classDiagram con un namespace por tema", () => {
    const def = buildDiagram(GRAPH, DIFF, opts);
    expect(def.kind).toBe("class");
    expect(def.code.startsWith("classDiagram")).toBe(true);
    expect(def.code).toContain("namespace Cuentas {");
    expect(def.code).toContain("namespace Contenido {");
    expect(def.code).toContain("class users {");
    // La flecha sigue yendo del hijo al padre.
    expect(def.code).toContain("comments --> users : user_id");
  });

  it("deja fuera de todo namespace a las tablas sin tema", () => {
    const def = buildDiagram(GRAPH, DIFF, opts);
    // `unrelated` no está en el mapa de grupos: se emite suelto, sin envoltura.
    const lines = def.code.split("\n");
    const i = lines.findIndex((l) => l.includes("class unrelated {"));
    expect(i).toBeGreaterThan(-1);
    expect(lines[i].startsWith("  class")).toBe(true); // sangría de nivel raíz
  });

  it("sanea los nombres de tema con espacios, que romperían el parseo", () => {
    const spaced = new Map([
      ["users", { id: "g1", name: "Service Types", tables: ["users"], confidence: 1 }],
    ]);
    const def = buildDiagram(GRAPH, DIFF, { ...opts, groupByTable: spaced });
    expect(def.code).toContain("namespace Service_Types {");
    expect(def.code).not.toContain("namespace Service Types");
  });

  it("filtra a un solo tema, conservando las tablas con las que se relaciona", () => {
    const def = buildDiagram(GRAPH, DIFF, { ...opts, onlyGroupId: "g2" });
    // comments es el tema pedido; users/comments se conservan por la relación.
    expect(def.code).toContain("class comments {");
    expect(def.code).toContain("class users {");
    expect(def.code).not.toContain("class unrelated {");
    expect(def.hiddenEntities).toBeGreaterThan(0);
  });

  it("mantiene el modo ER cuando no se pide agrupar", () => {
    const def = buildDiagram(GRAPH, DIFF, OPTIONS);
    expect(def.kind).toBe("er");
    expect(def.code.startsWith("erDiagram")).toBe(true);
    expect(def.code).not.toContain("namespace");
  });
});
