/**
 * `diffGraphs` — la comparación contra la rama base. Es la única parte de
 * `schema-inspector.ts` que es pura (todo lo demás corre scripts y `git`), y es
 * la que decide qué se pinta de verde, rojo o amarillo en el diagrama.
 *
 * Escrito en la OLA BE (frente BE2) ANTES de partir `diffGraphs` en
 * `diffEntities` + `diffRelations`, y verificado contra el código viejo: si
 * pasara con la función rota no probaría nada.
 */
import { describe, expect, it } from "vitest";

import { diffGraphs, relationKey } from "./schema-inspector.js";
import type {
  SchemaEntity,
  SchemaField,
  SchemaGraph,
  SchemaRelation,
} from "../../shared/types.js";

const field = (name: string, over: Partial<SchemaField> = {}): SchemaField => ({
  name,
  type: "text",
  nullable: false,
  primaryKey: false,
  pending: false,
  ...over,
});

const entity = (name: string, fields: SchemaField[] = []): SchemaEntity => ({
  name,
  fields,
  sourceFile: `db/${name}.sql`,
  sourceLine: 1,
  pending: false,
});

const relation = (
  from: string,
  fromField: string,
  to: string,
  onDelete: string | null = null,
): SchemaRelation => ({
  from,
  fromField,
  to,
  onDelete,
  sourceFile: `db/${from}.sql`,
  sourceLine: 2,
  pending: false,
});

const graph = (
  entities: SchemaEntity[],
  relations: SchemaRelation[] = [],
): SchemaGraph => ({
  repoName: "repo",
  dialect: "generado",
  sourceFiles: [],
  entities,
  relations,
});

describe("diffGraphs", () => {
  it("no reporta nada cuando los dos grafos son iguales", () => {
    const g = graph(
      [entity("users", [field("id", { primaryKey: true })]), entity("posts")],
      [relation("posts", "user_id", "users", "cascade")],
    );

    expect(diffGraphs(g, g)).toEqual({ entities: {}, fields: {}, relations: {} });
  });

  it("marca una tabla nueva y TODAS sus columnas como agregadas", () => {
    const base = graph([entity("users", [field("id")])]);
    const current = graph([
      entity("users", [field("id")]),
      entity("posts", [field("id"), field("title")]),
    ]);

    const diff = diffGraphs(base, current);
    expect(diff.entities).toEqual({ posts: "added" });
    expect(diff.fields).toEqual({ "posts.id": "added", "posts.title": "added" });
  });

  it("marca una tabla que desapareció y todas sus columnas como removidas", () => {
    const base = graph([
      entity("users", [field("id")]),
      entity("legacy", [field("a"), field("b")]),
    ]);
    const current = graph([entity("users", [field("id")])]);

    const diff = diffGraphs(base, current);
    expect(diff.entities).toEqual({ legacy: "removed" });
    expect(diff.fields).toEqual({ "legacy.a": "removed", "legacy.b": "removed" });
  });

  it("marca la tabla como cambiada cuando difiere una columna, y dice cómo", () => {
    const base = graph([
      entity("users", [field("id"), field("email"), field("nick")]),
    ]);
    const current = graph([
      entity("users", [
        field("id"),
        field("email", { nullable: true }),
        field("apodo"),
      ]),
    ]);

    const diff = diffGraphs(base, current);
    expect(diff.entities).toEqual({ users: "changed" });
    expect(diff.fields).toEqual({
      "users.email": "changed",
      "users.apodo": "added",
      "users.nick": "removed",
    });
  });

  it("detecta el cambio en cada atributo de una columna, uno por uno", () => {
    const attrs: Array<Partial<SchemaField>> = [
      { type: "bigint" },
      { nullable: true },
      { primaryKey: true },
      { default: "now()" },
    ];

    for (const over of attrs) {
      const base = graph([entity("users", [field("col")])]);
      const current = graph([entity("users", [field("col", over)])]);
      expect(diffGraphs(base, current).fields).toEqual({ "users.col": "changed" });
    }
  });

  it("ignora los campos que no describen la columna (origen y pending)", () => {
    const base = graph([entity("users", [field("col")])]);
    const current: SchemaGraph = {
      ...graph([entity("users", [field("col", { pending: true })])]),
    };
    current.entities[0]!.sourceLine = 99;

    expect(diffGraphs(base, current)).toEqual({
      entities: {},
      fields: {},
      relations: {},
    });
  });

  it("compara relaciones por origen, campo y destino, y detecta el ON DELETE", () => {
    const base = graph(
      [entity("posts"), entity("users"), entity("tags")],
      [
        relation("posts", "user_id", "users", "cascade"),
        relation("posts", "tag_id", "tags"),
      ],
    );
    const current = graph(
      [entity("posts"), entity("users"), entity("tags")],
      [
        relation("posts", "user_id", "users", "restrict"),
        relation("posts", "author_id", "users"),
      ],
    );

    const diff = diffGraphs(base, current);
    expect(diff.relations).toEqual({
      "posts.user_id->users": "changed",
      "posts.author_id->users": "added",
      "posts.tag_id->tags": "removed",
    });
    expect(diff.entities).toEqual({});
  });

  it("usa la misma clave de relación que expone relationKey", () => {
    const r = relation("posts", "user_id", "users");
    expect(relationKey(r)).toBe("posts.user_id->users");
    expect(Object.keys(diffGraphs(graph([]), graph([], [r])).relations)).toEqual([
      relationKey(r),
    ]);
  });
});
