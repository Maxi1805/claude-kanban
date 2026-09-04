/**
 * Test de caracterización del Louvain determinista de `cluster.ts`.
 *
 * NO existía antes de la Ola BE: se escribió para poder partir
 * `runLocalMoving`/`aggregateGraph`/`louvainRepresentative` sin cambiar el
 * resultado. Lo único que este archivo promete es lo que el módulo promete:
 * **misma entrada -> misma salida, siempre**, y una partición concreta y
 * verificada a mano sobre un esquema con temas claros más un hub.
 *
 * Por eso las aserciones son sobre la partición EXACTA (qué tabla cae en qué
 * id de grupo), no sobre "cuántos grupos hay": un cambio de orden de
 * iteración o de desempate mueve los ids y este test lo ve.
 */
import { describe, expect, it } from "vitest";

import { clusterSchema, identifyHubs, type SchemaEntity, type SchemaRelation } from "./cluster";

function entities(...names: string[]): SchemaEntity[] {
  return names.map((name) => ({ name }));
}

function rel(from: string, to: string, fromField = `${to}_id`): SchemaRelation {
  return { from, to, fromField };
}

/**
 * Comercio (`orders`/`order_items`/`products`/`carts`) y contenido
 * (`posts`/`comments`), unidos sólo por `users`, que es el hub que ambos
 * referencian; el par `tags`/`post_tags` cuelga del contenido por un solo
 * puente y Louvain lo separa en un tercer tema — verificado a mano, no es
 * ruido del algoritmo.
 */
const SCHEMA = {
  entities: entities(
    "users",
    "orders",
    "order_items",
    "products",
    "carts",
    "posts",
    "comments",
    "tags",
    "post_tags",
  ),
  relations: [
    rel("orders", "users"),
    rel("orders", "carts"),
    rel("order_items", "orders"),
    rel("order_items", "products"),
    rel("carts", "users"),
    rel("carts", "products"),
    rel("posts", "users"),
    rel("comments", "posts"),
    rel("comments", "users"),
    rel("post_tags", "posts"),
    rel("post_tags", "tags"),
  ],
};

function asObject(m: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

describe("clusterSchema", () => {
  it("devuelve la misma partición exacta en cada corrida", () => {
    const first = asObject(clusterSchema(SCHEMA.entities, SCHEMA.relations));
    for (let i = 0; i < 20; i++) {
      expect(asObject(clusterSchema(SCHEMA.entities, SCHEMA.relations))).toEqual(first);
    }
  });

  it("separa comercio, contenido y etiquetas, con ids estables", () => {
    const groups = asObject(clusterSchema(SCHEMA.entities, SCHEMA.relations));
    expect(groups).toEqual({
      carts: 0,
      comments: 1,
      order_items: 0,
      orders: 0,
      post_tags: 2,
      posts: 1,
      products: 0,
      tags: 2,
      users: 1,
    });
  });

  it("no depende del orden en que llegan tablas ni relaciones", () => {
    const base = asObject(clusterSchema(SCHEMA.entities, SCHEMA.relations));
    const shuffled = asObject(
      clusterSchema([...SCHEMA.entities].reverse(), [...SCHEMA.relations].reverse()),
    );
    expect(shuffled).toEqual(base);
  });

  it("con resolution alta parte en más grupos, con resolution baja en menos", () => {
    const count = (resolution: number): number =>
      new Set(clusterSchema(SCHEMA.entities, SCHEMA.relations, { resolution }).values()).size;
    expect(count(3)).toBeGreaterThan(count(1));
    expect(count(0.2)).toBeLessThanOrEqual(count(1));
  });

  it("una tabla aislada es su propio grupo, y el esquema vacío no tiene grupos", () => {
    const groups = clusterSchema(entities("solitaria", "orders", "users"), [rel("orders", "users")]);
    expect(groups.get("solitaria")).not.toBe(groups.get("orders"));
    expect(clusterSchema([], []).size).toBe(0);
  });

  it("un esquema sin ninguna relación deja cada tabla en su propio grupo", () => {
    const groups = clusterSchema(entities("a", "b", "c"), []);
    expect(new Set(groups.values()).size).toBe(3);
  });

  it("las auto-referencias no fusionan ni parten nada", () => {
    const withSelf = asObject(
      clusterSchema(SCHEMA.entities, [...SCHEMA.relations, rel("users", "users", "invited_by_id")]),
    );
    expect(withSelf).toEqual(asObject(clusterSchema(SCHEMA.entities, SCHEMA.relations)));
  });

  it("una FK hacia una tabla ausente de `entities` la incorpora igual al grafo", () => {
    // `buildWeightedAdjacency` toma los nodos de las relaciones además de las
    // entidades: una tabla que sólo aparece como destino de una FK entra al
    // resultado, no se descarta en silencio.
    const groups = clusterSchema(SCHEMA.entities, [
      ...SCHEMA.relations,
      rel("orders", "tabla_fantasma"),
    ]);
    expect(groups.has("tabla_fantasma")).toBe(true);
    expect(groups.get("tabla_fantasma")).toBe(groups.get("orders"));
  });

  it("los ids de grupo van de 0 a k-1 sin huecos", () => {
    const ids = [...clusterSchema(SCHEMA.entities, SCHEMA.relations).values()].sort((a, b) => a - b);
    const distinct = [...new Set(ids)];
    expect(distinct).toEqual(distinct.map((_, i) => i));
  });
});

describe("identifyHubs", () => {
  it("marca la tabla más referenciada cuando se baja el umbral", () => {
    expect(identifyHubs(SCHEMA.entities, SCHEMA.relations, { degreeThreshold: 4 })).toEqual(
      new Set(["users"]),
    );
  });

  it("con el umbral por defecto un esquema chico no tiene hubs", () => {
    expect(identifyHubs(SCHEMA.entities, SCHEMA.relations)).toEqual(new Set());
  });
});
