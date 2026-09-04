/**
 * Hotspot-map tests.
 *
 * The map is only trustworthy if a circle's colour and size mean what the user
 * assumes: colour = the worst thing in there, size = how much code it is. These
 * cover that, plus the two shaping decisions that are easy to get wrong —
 * attributing a multi-file duplication to one file, and collapsing the long
 * single-child directory chains that Rails and Nuxt trees are full of.
 */
import { describe, expect, it } from "vitest";

import { buildTree, layout, rankedFiles, tierFor } from "./hotspot-map";
import type { CodeAnalysis, CodeFinding } from "@shared/types";

const finding = (
  file: string,
  severity: number,
  extraFiles: string[] = [],
): CodeFinding => ({
  kind: "duplication",
  title: `hallazgo en ${file}`,
  detail: "",
  metric: { label: "copias", value: 1 + extraFiles.length },
  severity,
  locations: [file, ...extraFiles].map((f) => ({ file: f, startLine: 1, endLine: 9 })),
});

const analysis = (over: Partial<CodeAnalysis> = {}): CodeAnalysis => ({
  repoName: "backend",
  scannedFiles: 0,
  analysedFiles: 0,
  totalLines: 0,
  languages: ["ruby"],
  files: [],
  findings: [],
  ...over,
});

describe("tierFor", () => {
  it("mapea severidad a tramos crecientes", () => {
    expect(tierFor(0)).toBe("clean");
    expect(tierFor(20)).toBe("low");
    expect(tierFor(50)).toBe("medium");
    expect(tierFor(70)).toBe("high");
    expect(tierFor(95)).toBe("critical");
  });
});

describe("buildTree", () => {
  it("arma el árbol de directorios y suma líneas hacia arriba", () => {
    const root = buildTree(
      analysis({
        files: [
          { path: "app/models/user.rb", lines: 100, language: "ruby" },
          { path: "app/models/deal.rb", lines: 50, language: "ruby" },
          { path: "app/jobs/sync.rb", lines: 30, language: "ruby" },
        ],
      }),
    );

    expect(root.lines).toBe(180);
    // `app` tiene dos hijos, así que sobrevive como anillo propio: es una
    // agrupación real, no una cadena de un solo hijo.
    expect(root.children!.map((c) => c.name)).toEqual(["app"]);
    const app = root.children![0];
    expect(app.children!.map((c) => c.name).sort()).toEqual(["jobs", "models"]);
    const models = app.children!.find((c) => c.name === "models")!;
    expect(models.lines).toBe(150);
    expect(models.children!.map((c) => c.name).sort()).toEqual(["deal.rb", "user.rb"]);
  });

  it("colorea cada nodo por el PEOR hallazgo, no por la cantidad", () => {
    const root = buildTree(
      analysis({
        files: [
          { path: "a.rb", lines: 10, language: "ruby" },
          { path: "b.rb", lines: 10, language: "ruby" },
        ],
        // `a` tiene tres problemas menores; `b` uno grave. `b` debe verse peor.
        findings: [
          finding("a.rb", 30),
          finding("a.rb", 25),
          finding("a.rb", 20),
          finding("b.rb", 95),
        ],
      }),
    );

    const byName = new Map(root.children!.map((c) => [c.name, c]));
    expect(byName.get("a.rb")!.tier).toBe("low");
    expect(byName.get("b.rb")!.tier).toBe("critical");
    // El directorio hereda lo peor que contiene.
    expect(root.tier).toBe("critical");
  });

  it("atribuye una duplicación a un solo archivo, no a todas sus copias", () => {
    const root = buildTree(
      analysis({
        files: [
          { path: "a.rb", lines: 10, language: "ruby" },
          { path: "b.rb", lines: 10, language: "ruby" },
          { path: "c.rb", lines: 10, language: "ruby" },
        ],
        findings: [finding("a.rb", 90, ["b.rb", "c.rb"])],
      }),
    );

    const byName = new Map(root.children!.map((c) => [c.name, c]));
    expect(byName.get("a.rb")!.findings).toHaveLength(1);
    // Pintar de rojo las tres por UN problema exageraría el daño.
    expect(byName.get("b.rb")!.findings).toHaveLength(0);
    expect(byName.get("c.rb")!.tier).toBe("clean");
  });

  it("colapsa cadenas de directorios con un solo hijo", () => {
    const root = buildTree(
      analysis({
        files: [{ path: "app/services/calendar/strategies/base.rb", lines: 10, language: "ruby" }],
      }),
    );
    // Cuatro anillos sin nada que comparar dentro no aportan: se funden en uno.
    expect(root.children).toHaveLength(1);
    expect(root.children![0].name).toBe("app/services/calendar/strategies");
    expect(root.children![0].children!.map((c) => c.name)).toEqual(["base.rb"]);
  });

  it("mantiene los archivos de la raíz del repo", () => {
    const root = buildTree(
      analysis({ files: [{ path: "Rakefile.rb", lines: 5, language: "ruby" }] }),
    );
    expect(root.children!.map((c) => c.name)).toEqual(["Rakefile.rb"]);
  });
});

describe("layout", () => {
  const root = buildTree(
    analysis({
      files: [
        { path: "big.rb", lines: 400, language: "ruby" },
        { path: "small.rb", lines: 25, language: "ruby" },
      ],
    }),
  );
  const circles = layout(root, 500);

  it("dimensiona por líneas: más código, más área", () => {
    const big = circles.find((c) => c.node.name === "big.rb")!;
    const small = circles.find((c) => c.node.name === "small.rb")!;
    expect(big.r).toBeGreaterThan(small.r);
    // El área sigue a las líneas, no el radio.
    const ratio = (big.r * big.r) / (small.r * small.r);
    expect(ratio).toBeGreaterThan(10);
    expect(ratio).toBeLessThan(22);
  });

  it("deja todo dentro del lienzo", () => {
    for (const c of circles) {
      expect(c.x - c.r).toBeGreaterThanOrEqual(-1);
      expect(c.y - c.r).toBeGreaterThanOrEqual(-1);
      expect(c.x + c.r).toBeLessThanOrEqual(501);
      expect(c.y + c.r).toBeLessThanOrEqual(501);
    }
  });

  it("no le da radio cero a un archivo vacío", () => {
    const empty = layout(
      buildTree(analysis({ files: [{ path: "empty.rb", lines: 0, language: "ruby" }] })),
      200,
    );
    expect(empty.find((c) => c.isFile)!.r).toBeGreaterThan(0);
  });
});

describe("buildTree con eje alternativo (CONTRATO-F7.md §2.5)", () => {
  it("con axis omitido o 'lineas' es byte-idéntico al comportamiento de siempre", () => {
    const files = [
      { path: "a.rb", lines: 100, language: "ruby" },
      { path: "b.rb", lines: 10, language: "ruby" },
    ];
    const findings = [finding("a.rb", 90)];
    const withoutAxis = buildTree(analysis({ files, findings }));
    const withLineas = buildTree(analysis({ files, findings }), "lineas");
    expect(withLineas).toEqual(withoutAxis);
    expect(withoutAxis.children!.find((c) => c.name === "a.rb")!.weight).toBe(100);
  });

  it("'impacto' pesa por score/severidad, no por líneas: un archivo chico y grave pesa más", () => {
    const root = buildTree(
      analysis({
        files: [
          { path: "big-clean.rb", lines: 1000, language: "ruby" },
          { path: "small-bad.rb", lines: 10, language: "ruby" },
        ],
        findings: [finding("small-bad.rb", 95)],
      }),
      "impacto",
    );
    const byName = new Map(root.children!.map((c) => [c.name, c]));
    expect(byName.get("small-bad.rb")!.weight).toBeGreaterThan(byName.get("big-clean.rb")!.weight);
    // Las líneas reales no se falsean sólo porque el eje cambió.
    expect(byName.get("big-clean.rb")!.lines).toBe(1000);
  });

  it("'impacto' nunca da peso cero: un archivo limpio sigue siendo un punto visible", () => {
    const root = buildTree(
      analysis({ files: [{ path: "clean.rb", lines: 500, language: "ruby" }] }),
      "impacto",
    );
    expect(root.children![0]!.weight).toBeGreaterThan(0);
  });

  it("'densidad' es hallazgos por 1.000 líneas: mismo conteo, distinto tamaño de archivo", () => {
    const root = buildTree(
      analysis({
        files: [
          { path: "dense.rb", lines: 100, language: "ruby" },
          { path: "sparse.rb", lines: 10000, language: "ruby" },
        ],
        findings: [finding("dense.rb", 50), finding("sparse.rb", 50)],
      }),
      "densidad",
    );
    const byName = new Map(root.children!.map((c) => [c.name, c]));
    // Un hallazgo cada 100 líneas es mucho más denso que uno cada 10.000.
    expect(byName.get("dense.rb")!.weight).toBeGreaterThan(byName.get("sparse.rb")!.weight);
  });

  it("layout() empaqueta por weight, no por lines, cuando el eje no es 'lineas'", () => {
    const root = buildTree(
      analysis({
        files: [
          { path: "big-clean.rb", lines: 1000, language: "ruby" },
          { path: "small-bad.rb", lines: 10, language: "ruby" },
        ],
        findings: [finding("small-bad.rb", 95)],
      }),
      "impacto",
    );
    const circles = layout(root, 500);
    const bigClean = circles.find((c) => c.node.name === "big-clean.rb")!;
    const smallBad = circles.find((c) => c.node.name === "small-bad.rb")!;
    expect(smallBad.r).toBeGreaterThan(bigClean.r);
  });
});

describe("rankedFiles", () => {
  it("lista solo archivos con hallazgos, del peor al mejor", () => {
    const root = buildTree(
      analysis({
        files: [
          { path: "app/a.rb", lines: 10, language: "ruby" },
          { path: "app/b.rb", lines: 10, language: "ruby" },
          { path: "app/sano.rb", lines: 10, language: "ruby" },
        ],
        findings: [finding("app/a.rb", 40), finding("app/b.rb", 90)],
      }),
    );
    expect(rankedFiles(root).map((f) => f.name)).toEqual(["b.rb", "a.rb"]);
  });
});
