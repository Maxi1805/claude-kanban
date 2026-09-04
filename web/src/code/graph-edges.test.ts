/**
 * `graph-edges.ts` tests — CONTRATO-F7.md Contrato 2.
 *
 * Nivel 1 (co-problem edges, no backend): a finding/hypothesis touching
 * several files becomes a STAR (anchor → every other file), never the
 * complete graph — that's the difference between a 35-file duplication
 * group producing 34 edges (what ships) and 595 (what a naive C(k,2) would).
 */
import { describe, expect, it } from "vitest";

import type { CodeAnalysis, CodeFinding, CodeFindingHypothesis } from "@shared/types";

import { budget, collapseToFocus, deriveEdges, deriveEdgesWithScope, EDGE_KIND_LEGEND, edgeInk, ego } from "./graph-edges";

const finding = (
  over: Partial<CodeFinding> & { files: string[] },
): CodeFinding => ({
  kind: "duplication",
  title: "hallazgo",
  detail: "",
  metric: { label: "copias", value: over.files.length },
  severity: 50,
  locations: over.files.map((f) => ({ file: f, startLine: 1, endLine: 9 })),
  ...over,
});

const hypothesis = (
  over: Partial<CodeFindingHypothesis> & { files: string[] },
): CodeFindingHypothesis => ({
  pattern: "Strategy",
  layer: "patron",
  state: "ausente",
  confidence: "media",
  ceiling: "media",
  provisional: true,
  checks: [],
  discriminators: [],
  places: over.files.map((f) => ({ file: f, startLine: 1, endLine: 9, role: "rama" })),
  toConfirm: [],
  cost: "",
  source: "",
  missingCapabilities: [],
  anchorFindingId: "f1",
  ...over,
});

const analysis = (over: Partial<CodeAnalysis> = {}): CodeAnalysis => ({
  repoName: "repo",
  scannedFiles: 0,
  analysedFiles: 0,
  totalLines: 0,
  languages: [],
  files: [],
  findings: [],
  ...over,
});

describe("deriveEdges", () => {
  it("un hallazgo de un solo archivo no produce arista", () => {
    expect(deriveEdges(analysis({ findings: [finding({ files: ["a.rb"] })] }))).toHaveLength(0);
  });

  it("arma una ESTRELLA desde el ancla (primera ubicación), no el grafo completo", () => {
    const edges = deriveEdges(
      analysis({ findings: [finding({ files: ["a.rb", "b.rb", "c.rb", "d.rb"] })] }),
    );
    // 4 archivos → 3 aristas (ancla-b, ancla-c, ancla-d), nunca C(4,2)=6.
    expect(edges).toHaveLength(3);
    expect(edges.every((e) => e.a === "a.rb")).toBe(true);
    expect(edges.map((e) => e.b).sort()).toEqual(["b.rb", "c.rb", "d.rb"]);
    expect(edges.every((e) => e.kind === "duplicacion")).toBe(true);
  });

  it("usa score si está, si no severity/100", () => {
    const [withScore] = deriveEdges(
      analysis({ findings: [finding({ files: ["a.rb", "b.rb"], score: 0.77, severity: 10 })] }),
    );
    expect(withScore!.weight).toBe(0.77);
    const [withoutScore] = deriveEdges(
      analysis({ findings: [finding({ files: ["a.rb", "b.rb"], severity: 40 })] }),
    );
    expect(withoutScore!.weight).toBeCloseTo(0.4);
  });

  it("dos problemas entre el mismo par de archivos se fusionan en UNA arista", () => {
    const edges = deriveEdges(
      analysis({
        findings: [
          finding({ files: ["a.rb", "b.rb"], title: "primero", severity: 30 }),
          finding({ files: ["b.rb", "a.rb"], title: "segundo", severity: 90 }), // orden invertido
        ],
      }),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]!.weight).toBeCloseTo(0.9); // se queda con el más fuerte
    expect(edges[0]!.label).toContain("+1 más");
  });

  it("hipótesis con confianza pesa según confianza; sin confianza, según el estado", () => {
    const finding1: CodeFinding = {
      ...finding({ files: ["f.rb"] }),
      id: "f1",
      hypotheses: [
        hypothesis({ files: ["f.rb", "g.rb"], confidence: "alta" }),
        hypothesis({
          files: ["f.rb", "h.rb"],
          confidence: null,
          state: "aplicado-eludido",
        }),
      ],
    };
    const edges = deriveEdges(analysis({ findings: [finding1] }));
    const hip = edges.filter((e) => e.kind === "hipotesis");
    expect(hip).toHaveLength(2);
    expect(hip.find((e) => e.b === "g.rb")!.weight).toBeCloseTo(0.9);
    // aplicado-eludido sin confidence sigue pesando ALTO — es la fuga que
    // justifica dibujar la arista, no "sin señal".
    expect(hip.find((e) => e.b === "h.rb")!.weight).toBeCloseTo(0.8);
  });

  it("problema 2 — un par con duplicación E hipótesis fusiona en UNA arista, no dos curvas paralelas", () => {
    const findingWithHypothesis: CodeFinding = {
      ...finding({ files: ["a.rb", "b.rb"], severity: 40 }), // duplicacion weight 0.4
      id: "f1",
      hypotheses: [hypothesis({ files: ["a.rb", "b.rb"], confidence: "alta" })], // hipotesis weight 0.9
    };
    const edges = deriveEdges(analysis({ findings: [findingWithHypothesis] }));
    // UNA sola arista para el par (a.rb, b.rb), no una por kind.
    expect(edges).toHaveLength(1);
    const [edge] = edges;
    // El componente dominante es el de mayor peso (hipotesis, 0.9).
    expect(edge!.kind).toBe("hipotesis");
    expect(edge!.weight).toBeCloseTo(0.9);
    // Pero NO se pierde la duplicación: sigue enumerada en `components`.
    expect(edge!.components).toHaveLength(2);
    const kinds = edge!.components!.map((c) => c.kind).sort();
    expect(kinds).toEqual(["duplicacion", "hipotesis"]);
    const dup = edge!.components!.find((c) => c.kind === "duplicacion")!;
    expect(dup.weight).toBeCloseTo(0.4);
    expect(edge!.label).toContain("tipo");
  });

  it("problema 2 — sin mezcla de kinds, components tiene una sola entrada y el label no menciona tipos", () => {
    const [edge] = deriveEdges(analysis({ findings: [finding({ files: ["a.rb", "b.rb"] })] }));
    expect(edge!.components).toHaveLength(1);
    expect(edge!.components![0]!.kind).toBe("duplicacion");
    expect(edge!.label).not.toContain("tipo");
  });
});

describe("EDGE_KIND_LEGEND", () => {
  it("declara label y color para los 3 CoEdgeKind, congelado para P4", () => {
    const kinds = ["duplicacion", "hipotesis", "referencia"] as const;
    for (const kind of kinds) {
      expect(EDGE_KIND_LEGEND[kind].label.length).toBeGreaterThan(0);
      expect(EDGE_KIND_LEGEND[kind].color).toMatch(/^\d+, \d+, \d+$/);
    }
  });
});

describe("deriveEdgesWithScope — problema 1: alcance declarado", () => {
  it("sin `page` en el análisis, el alcance es 'desconocido' — nunca se asume completo", () => {
    const { scope } = deriveEdgesWithScope(
      analysis({ findings: [finding({ files: ["a.rb", "b.rb"] })] }),
    );
    expect(scope.completeness).toBe("desconocido");
    expect(scope.findingsExamined).toBe(1);
    expect(scope.page).toBeUndefined();
  });

  it("con `page.hasMore: true`, el alcance es 'parcial' — es una página, no el universo", () => {
    const { scope } = deriveEdgesWithScope(
      analysis({
        findings: [finding({ files: ["a.rb", "b.rb"] })],
        page: { offset: 0, limit: 200, hasMore: true },
        groupsTotal: 1312,
      }),
    );
    expect(scope.completeness).toBe("parcial");
    expect(scope.groupsTotal).toBe(1312);
  });

  it("página siguiente (`offset > 0`, `hasMore: false`) sigue siendo 'parcial', no 'completo'", () => {
    const { scope } = deriveEdgesWithScope(
      analysis({
        findings: [finding({ files: ["a.rb", "b.rb"] })],
        page: { offset: 200, limit: 200, hasMore: false },
      }),
    );
    expect(scope.completeness).toBe("parcial");
  });

  it("`offset: 0` y `hasMore: false` es el único caso 'completo'", () => {
    const { scope } = deriveEdgesWithScope(
      analysis({
        findings: [finding({ files: ["a.rb", "b.rb"] })],
        page: { offset: 0, limit: 200, hasMore: false },
      }),
    );
    expect(scope.completeness).toBe("completo");
  });

  it("cuenta hipótesis examinadas, no sólo las que producen arista", () => {
    const singleFileHypothesis: CodeFinding = {
      ...finding({ files: ["a.rb", "b.rb"] }),
      id: "f1",
      hypotheses: [hypothesis({ files: ["a.rb"] })], // 1 solo archivo: no produce arista
    };
    const { edges, scope } = deriveEdgesWithScope(analysis({ findings: [singleFileHypothesis] }));
    expect(edges.some((e) => e.kind === "hipotesis")).toBe(false);
    expect(scope.hypothesesExamined).toBe(1);
  });

  it("deriveEdges (firma vieja) sigue devolviendo sólo el arreglo, para no romper llamadores existentes", () => {
    const a = analysis({ findings: [finding({ files: ["a.rb", "b.rb"] })] });
    expect(deriveEdges(a)).toEqual(deriveEdgesWithScope(a).edges);
  });
});

describe("collapseToFocus", () => {
  const files = ["src/a.rb", "src/b.rb", "lib/c.rb"];
  const edges = [
    { a: "src/a.rb", b: "src/b.rb", kind: "duplicacion" as const, weight: 0.5, label: "x" },
    { a: "src/a.rb", b: "lib/c.rb", kind: "duplicacion" as const, weight: 0.5, label: "y" },
    { a: "lib/c.rb", b: "src/b.rb", kind: "duplicacion" as const, weight: 0.5, label: "z" },
  ];

  it("en la raíz (focusPath vacío) no colapsa nada", () => {
    expect(collapseToFocus(edges, "", files)).toHaveLength(3);
  });

  it("una arista totalmente fuera del foco se descarta", () => {
    const out = collapseToFocus(edges, "src", files);
    // "lib/c.rb" -- "src/b.rb" tiene un extremo adentro: colapsa, no se cae.
    // Sólo se cae si NINGÚN extremo está bajo "src" — no hay tal arista acá,
    // así que las 3 sobreviven, 2 colapsadas.
    expect(out).toHaveLength(3);
    const collapsed = out.filter((e) => e.a === "src" || e.b === "src");
    expect(collapsed).toHaveLength(2);
  });

  it("colapsa el extremo de afuera al directorio foco, nunca lo deja apuntando a un archivo invisible", () => {
    const out = collapseToFocus(edges, "src", files);
    const crossing = out.find((e) => (e.a === "src/a.rb" && e.b === "lib/c.rb") || (e.a === "lib/c.rb" && e.b === "src/a.rb"));
    expect(crossing).toBeUndefined();
    const toFocus = out.find((e) => e.a === "src/a.rb" && e.b === "src");
    expect(toFocus).toBeDefined();
  });

  it("descarta aristas con un extremo que no es un archivo conocido", () => {
    const out = collapseToFocus(
      [{ a: "src/a.rb", b: "ghost.rb", kind: "duplicacion" as const, weight: 1, label: "" }],
      "",
      files,
    );
    expect(out).toHaveLength(0);
  });
});

describe("budget", () => {
  it("corta al máximo pedido, rankeando por weight, y el sobrante es honesto", () => {
    const edges = Array.from({ length: 10 }, (_, i) => ({
      a: `a${i}.rb`,
      b: `b${i}.rb`,
      kind: "duplicacion" as const,
      weight: i,
      label: "",
    }));
    const { visible, hidden } = budget(edges, 3);
    expect(visible.map((e) => e.weight)).toEqual([9, 8, 7]);
    expect(hidden).toBe(7);
  });

  it("con menos aristas que el máximo, nada queda oculto", () => {
    const edges = [{ a: "a.rb", b: "b.rb", kind: "duplicacion" as const, weight: 1, label: "" }];
    expect(budget(edges, 120)).toEqual({ visible: edges, hidden: 0 });
  });
});

describe("ego", () => {
  // hub — a — b — c   (cadena), más un atajo hub—c para probar el hop 2.
  const edges = [
    { a: "hub.rb", b: "a.rb", kind: "duplicacion" as const, weight: 1, label: "" },
    { a: "a.rb", b: "b.rb", kind: "duplicacion" as const, weight: 1, label: "" },
    { a: "b.rb", b: "c.rb", kind: "duplicacion" as const, weight: 1, label: "" },
    { a: "hub.rb", b: "far.rb", kind: "duplicacion" as const, weight: 1, label: "" },
  ];

  it("1 salto: sólo vecinos directos", () => {
    const { nodes, edges: es } = ego(edges, "hub.rb", 1);
    expect(nodes.sort()).toEqual(["a.rb", "far.rb", "hub.rb"]);
    expect(es).toHaveLength(2);
  });

  it("2 saltos: también los vecinos de los vecinos", () => {
    const { nodes } = ego(edges, "hub.rb", 2);
    expect(nodes.sort()).toEqual(["a.rb", "b.rb", "far.rb", "hub.rb"]);
    // "c.rb" queda a 3 saltos: no entra.
    expect(nodes).not.toContain("c.rb");
  });

  it("un archivo sin aristas es un ego de un solo nodo", () => {
    expect(ego(edges, "solo.rb", 2)).toEqual({ nodes: ["solo.rb"], edges: [] });
  });
});

describe("edgeInk", () => {
  const e = (over: Partial<Parameters<typeof edgeInk>[0]>) =>
    edgeInk({ a: "a", b: "b", kind: "duplicacion", weight: 0.5, label: "", ...over });

  it("sin provenance (Nivel 1), la opacidad sigue al weight", () => {
    const weak = e({ weight: 0.1 });
    const strong = e({ weight: 0.9 });
    expect(strong.opacity).toBeGreaterThan(weak.opacity);
    expect(weak.dashed).toBe(false);
  });

  it("'inferred' pesa MENOS tinta que 'declared', a igual weight", () => {
    const declared = e({ weight: 0.7, provenance: "declared" });
    const inferred = e({ weight: 0.7, provenance: "inferred" });
    expect(inferred.opacity).toBeLessThan(declared.opacity);
    expect(inferred.dashed).toBe(true);
    expect(declared.dashed).toBe(false);
  });

  it("cada kind tiene su propio color", () => {
    const kinds = ["duplicacion", "hipotesis", "referencia"] as const;
    const colors = new Set(kinds.map((kind) => e({ kind }).rgb));
    expect(colors.size).toBe(kinds.length);
  });
});
