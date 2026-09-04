/**
 * Contract test for the one rule that must never break: `pack()` owns
 * `x`/`y`/`r`, and relaxing the edges' control points must not perturb them —
 * CONTRATO-F7.md §2.1.
 */
import { describe, expect, it } from "vitest";

import type { CoEdge } from "./graph-edges";
import {
  collapseHubs,
  EDGE_KIND_LEGEND_FALLBACK,
  edgeScopeFor,
  edgeScopeLabel,
  HUB_DEGREE_THRESHOLD,
  HUB_KEEP_PER_HUB,
  relaxControlPoints,
} from "./graph-layout";
import type { MapNode, PackedCircle } from "./hotspot-map";

function circle(path: string, x: number, y: number, r = 20): PackedCircle {
  const node: MapNode = {
    path,
    name: path,
    lines: 10,
    weight: 10,
    findings: [],
    worst: 0,
    tier: "clean",
  };
  return { node, x, y, r, depth: 1, isFile: true };
}

const edge = (a: string, b: string, weight = 0.5): CoEdge => ({ a, b, kind: "duplicacion", weight, label: a });

describe("relaxControlPoints", () => {
  it("nunca toca x/y/r de los círculos que recibe", () => {
    const circles = [circle("a.rb", 10, 10), circle("b.rb", 200, 200), circle("c.rb", 400, 50)];
    const before = JSON.parse(JSON.stringify(circles));

    relaxControlPoints(circles, [edge("a.rb", "b.rb"), edge("b.rb", "c.rb")], 500);

    expect(JSON.parse(JSON.stringify(circles))).toEqual(before);
  });

  it("devuelve un punto de control por arista", () => {
    const circles = [circle("a.rb", 10, 10), circle("b.rb", 200, 200)];
    const points = relaxControlPoints(circles, [edge("a.rb", "b.rb")], 500);
    expect(points).toHaveLength(1);
    expect(Number.isFinite(points[0]!.x)).toBe(true);
    expect(Number.isFinite(points[0]!.y)).toBe(true);
  });

  it("separa aristas paralelas entre el mismo par en vez de superponerlas", () => {
    const circles = [circle("hub.rb", 100, 100), circle("leaf.rb", 300, 100)];
    // Three DIFFERENT problems linking the exact same two files — the star
    // fan-out in `graph-edges.ts` never emits this (it dedups by pair), but
    // the overlay must still cope if a caller ever hands it parallel edges.
    const points = relaxControlPoints(
      circles,
      [edge("hub.rb", "leaf.rb"), edge("hub.rb", "leaf.rb"), edge("hub.rb", "leaf.rb")],
      500,
    );
    const ys = new Set(points.map((p) => Math.round(p.y)));
    expect(ys.size).toBeGreaterThan(1);
  });

  it("no explota con un endpoint desconocido: cae al centro del lienzo", () => {
    const circles = [circle("a.rb", 10, 10)];
    const points = relaxControlPoints(circles, [edge("a.rb", "no-existe.rb")], 500);
    expect(points).toHaveLength(1);
    expect(Number.isFinite(points[0]!.x)).toBe(true);
  });

  it("con cero aristas no arma una simulación", () => {
    expect(relaxControlPoints([circle("a.rb", 0, 0)], [], 500)).toEqual([]);
  });
});

/**
 * Problema 1 (P4) — reproduced live on guava's root: two files at degree 39
 * and 37 out of 120 drawn edges (63% of the ink on two circles). These tests
 * pin the fix's actual contract: cap any file's OWN edge count, don't just
 * rank everything by weight (that concentrates onto the same hubs instead of
 * dispersing — the bug in the first place).
 */
describe("collapseHubs", () => {
  it("no toca nada si ningún archivo supera el umbral", () => {
    const edges = [edge("a.rb", "b.rb"), edge("b.rb", "c.rb"), edge("c.rb", "d.rb")];
    const result = collapseHubs(edges, 10, 6);
    expect(result.edges).toEqual(edges);
    expect(result.hubs).toEqual([]);
  });

  it("capa un hub a sus `keep` aristas de mayor peso, y reporta cuántas plegó", () => {
    // "hub.rb" tiene 12 vecinos distintos — muy por encima del umbral 5.
    const edges = Array.from({ length: 12 }, (_, i) => edge("hub.rb", `leaf${i}.rb`, i / 11));
    const result = collapseHubs(edges, 5, 3);

    const hubDegree = result.edges.filter((e) => e.a === "hub.rb" || e.b === "hub.rb").length;
    expect(hubDegree).toBe(3);
    expect(result.hubs).toEqual([{ path: "hub.rb", total: 12, collapsed: 9 }]);
    // Se quedan las de MAYOR peso, no las primeras del array.
    const survivingLeaves = result.edges.map((e) => e.b).sort();
    expect(survivingLeaves).toEqual(["leaf11.rb", "leaf9.rb", "leaf10.rb"].sort());
  });

  it("una arista entre dos hubs sobrevive si CUALQUIERA de los dos la protege", () => {
    // hub-a y hub-b comparten una arista fuerte entre ellos, más 6 hojas cada uno.
    const edges = [
      edge("hub-a.rb", "hub-b.rb", 0.99),
      ...Array.from({ length: 6 }, (_, i) => edge("hub-a.rb", `leafA${i}.rb`, 0.1)),
      ...Array.from({ length: 6 }, (_, i) => edge("hub-b.rb", `leafB${i}.rb`, 0.1)),
    ];
    const result = collapseHubs(edges, 5, 2);
    expect(result.edges).toContainEqual(edges[0]);
  });

  it("degrada el grafo denso de la raíz de guava: el hub más cargado baja de forma verificable", () => {
    // Reproduce la forma real: dos hubs muy cargados (39 y 37 en producción)
    // más el resto disperso — el criterio de éxito del brief es que el hub
    // más cargado baje, no que desaparezca.
    const edges = [
      ...Array.from({ length: 39 }, (_, i) => edge("ImmutableSet.java", `f${i}.java`, Math.random())),
      ...Array.from({ length: 37 }, (_, i) => edge("Ordering.java", `g${i}.java`, Math.random())),
      ...Array.from({ length: 20 }, (_, i) => edge(`p${i}.java`, `q${i}.java`, Math.random())),
    ];
    const result = collapseHubs(edges);
    const degreeOf = (path: string) => result.edges.filter((e) => e.a === path || e.b === path).length;
    expect(degreeOf("ImmutableSet.java")).toBeLessThanOrEqual(HUB_KEEP_PER_HUB);
    expect(degreeOf("Ordering.java")).toBeLessThanOrEqual(HUB_KEEP_PER_HUB);
    // Lo disperso, bajo el umbral, no se toca.
    expect(result.edges.length).toBe(HUB_KEEP_PER_HUB * 2 + 20);
    expect(HUB_DEGREE_THRESHOLD).toBeGreaterThan(0);
  });
});

/**
 * Problema 2 (P4) — reproducido en vivo: 506 relaciones en la página de
 * grupos 1–200, 191 en la de 201–400 (mismo repo, mismo foco) sin que el
 * mapa dijera de dónde salía cada número. `edgeScopeFor`/`edgeScopeLabel` son
 * el fallback local al contrato de P3 (su export no existía al escribir
 * esto — swap del import el día que aterrice).
 */
describe("edgeScopeFor / edgeScopeLabel", () => {
  const analysisWith = (over: { findingsCount: number; page?: { offset: number; limit: number; hasMore: boolean }; groupsTotal?: number }) => ({
    findings: Array.from({ length: over.findingsCount }, () => ({})) as never,
    page: over.page,
    groupsTotal: over.groupsTotal,
  });

  it("con page y groupsTotal: declara el rango exacto", () => {
    const scope = edgeScopeFor(analysisWith({ findingsCount: 200, page: { offset: 0, limit: 200, hasMore: true }, groupsTotal: 5165 }));
    expect(scope).toEqual({ rangeLabel: "1–200", totalGroups: 5165, loadedGroups: 200 });
    expect(edgeScopeLabel(scope)).toBe("de los grupos 1–200 de 5165 cargados");
  });

  it("la página 2 declara UN rango distinto de la página 1 — nunca el mismo texto para poblaciones distintas", () => {
    const page1 = edgeScopeFor(analysisWith({ findingsCount: 200, page: { offset: 0, limit: 200, hasMore: true }, groupsTotal: 5165 }));
    const page2 = edgeScopeFor(analysisWith({ findingsCount: 200, page: { offset: 200, limit: 200, hasMore: true }, groupsTotal: 5165 }));
    expect(edgeScopeLabel(page1)).not.toBe(edgeScopeLabel(page2));
    expect(edgeScopeLabel(page2)).toBe("de los grupos 201–400 de 5165 cargados");
  });

  it("sin page (análisis cacheado de antes de F5): sigue siendo honesto, sin inventar un rango", () => {
    const scope = edgeScopeFor(analysisWith({ findingsCount: 42 }));
    expect(scope.rangeLabel).toBeUndefined();
    expect(edgeScopeLabel(scope)).toBe("de los 42 grupos cargados (sin datos de paginación)");
  });

  it("con page pero sin groupsTotal: rango sí, denominador no", () => {
    const scope = edgeScopeFor(analysisWith({ findingsCount: 50, page: { offset: 0, limit: 50, hasMore: false } }));
    expect(edgeScopeLabel(scope)).toBe("de los grupos 1–50 cargados");
  });
});

describe("EDGE_KIND_LEGEND_FALLBACK", () => {
  it("cubre los dos kinds que deriveEdges emite hoy, ninguno repetido", () => {
    const kinds = EDGE_KIND_LEGEND_FALLBACK.map((e) => e.kind).sort();
    expect(kinds).toEqual(["duplicacion", "hipotesis"]);
  });

  it("el color de cada entrada es el mismo que edgeInk() le da a una arista real de ese kind", () => {
    for (const entry of EDGE_KIND_LEGEND_FALLBACK) {
      expect(entry.rgb).toMatch(/^\d+, \d+, \d+$/);
    }
  });
});
