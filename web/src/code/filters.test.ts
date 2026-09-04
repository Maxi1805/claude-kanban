/**
 * Filtros de granularidad / lenguaje / confianza — ver filters.ts para la why.
 */
import { describe, expect, it } from "vitest";
import type { CodeDetectorScope, CodeFileSummary, CodeFinding } from "@shared/types";

import {
  CONFIDENCE_TIER_LABELS,
  confidenceTier,
  familiesIn,
  filterByConfidence,
  filterByFamily,
  filterByGranularity,
  filterByLanguage,
  granularityOf,
  hasConfidenceData,
  languageMap,
  languageOf,
  languagesIn,
} from "./filters";

function finding(overrides: Partial<CodeFinding> = {}): CodeFinding {
  return {
    kind: "unused-variable",
    title: "Variable sin uso",
    detail: "",
    metric: { label: "usos", value: 0 },
    severity: 40,
    locations: [{ file: "src/a.java", startLine: 1, endLine: 1 }],
    ...overrides,
  };
}

describe("filterByGranularity / granularityOf", () => {
  const scopeMap = new Map<string, CodeDetectorScope>([
    ["unused-variable", "intra-function"],
    ["dependency-cycle", "inter-file"],
  ]);

  it("resuelve la granularidad vía el mapa kind -> scope", () => {
    expect(granularityOf(finding({ kind: "unused-variable" }), scopeMap)).toBe("intra-function");
  });

  it("da null para un kind ausente del mapa (análisis sin cobertura)", () => {
    expect(granularityOf(finding({ kind: "misterio" }), scopeMap)).toBeNull();
  });

  it("null pasa todo cuando el filtro es null", () => {
    const list = [finding({ kind: "unused-variable" }), finding({ kind: "dependency-cycle" })];
    expect(filterByGranularity(list, null, scopeMap)).toHaveLength(2);
  });

  it("filtra por la granularidad pedida", () => {
    const list = [finding({ kind: "unused-variable" }), finding({ kind: "dependency-cycle" })];
    expect(filterByGranularity(list, "inter-file", scopeMap)).toHaveLength(1);
  });

  it("un hallazgo sin granularidad conocida nunca pasa un filtro activo", () => {
    const list = [finding({ kind: "misterio" })];
    expect(filterByGranularity(list, "inter-file", scopeMap)).toHaveLength(0);
  });
});

describe("languageMap / languageOf / filterByLanguage / languagesIn", () => {
  const files: CodeFileSummary[] = [
    { path: "src/a.java", lines: 10, language: "java" },
    { path: "src/b.go", lines: 20, language: "go" },
  ];
  const langs = languageMap(files);

  it("resuelve el lenguaje del archivo primario", () => {
    expect(languageOf(finding({ locations: [{ file: "src/a.java", startLine: 1, endLine: 1 }] }), langs)).toBe(
      "java",
    );
  });

  it("da null para un archivo que no está en `files`", () => {
    expect(languageOf(finding({ locations: [{ file: "src/c.rb", startLine: 1, endLine: 1 }] }), langs)).toBeNull();
  });

  it("filtra por lenguaje", () => {
    const list = [
      finding({ locations: [{ file: "src/a.java", startLine: 1, endLine: 1 }] }),
      finding({ locations: [{ file: "src/b.go", startLine: 1, endLine: 1 }] }),
    ];
    expect(filterByLanguage(list, "go", langs)).toHaveLength(1);
  });

  it("languagesIn devuelve lenguajes distintos, orden alfabético", () => {
    const list = [
      finding({ locations: [{ file: "src/b.go", startLine: 1, endLine: 1 }] }),
      finding({ locations: [{ file: "src/a.java", startLine: 1, endLine: 1 }] }),
      finding({ locations: [{ file: "src/a.java", startLine: 2, endLine: 2 }] }),
    ];
    expect(languagesIn(list, langs)).toEqual(["go", "java"]);
  });
});

describe("confianza — hueco de cableado", () => {
  it("hasConfidenceData es false cuando ningún hallazgo trae `conf`", () => {
    expect(hasConfidenceData([finding(), finding()])).toBe(false);
  });

  it("hasConfidenceData es true en cuanto UNO lo trae", () => {
    const withConf = { ...finding(), conf: 0.7 } as CodeFinding;
    expect(hasConfidenceData([finding(), withConf])).toBe(true);
  });

  it("confidenceTier es null sin el campo, y clasifica los tres tramos cuando está", () => {
    expect(confidenceTier(finding())).toBeNull();
    expect(confidenceTier({ ...finding(), conf: 1.0 } as CodeFinding)).toBe("alta");
    expect(confidenceTier({ ...finding(), conf: 0.7 } as CodeFinding)).toBe("media");
    expect(confidenceTier({ ...finding(), conf: 0.5 } as CodeFinding)).toBe("baja");
  });

  it("filterByConfidence filtra por tramo cuando se pide uno", () => {
    const list = [
      { ...finding({ title: "a" }), conf: 1.0 } as CodeFinding,
      { ...finding({ title: "b" }), conf: 0.5 } as CodeFinding,
    ];
    expect(filterByConfidence(list, "alta")).toHaveLength(1);
    expect(filterByConfidence(list, null)).toHaveLength(2);
  });

  it("las tres etiquetas están declaradas", () => {
    expect(CONFIDENCE_TIER_LABELS).toEqual({ alta: "Alta", media: "Media", baja: "Baja" });
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * OLA BB, FRENTE BB2 — el filtro por FAMILIA PROPUESTA.
 * *"tener una lista infinita es medio complicado para ver un patrón
 * específico"*. `kind` filtra por el problema medido; esto, por la solución
 * propuesta. Son ejes distintos y el test lo fija.
 * ──────────────────────────────────────────────────────────────────────── */

type Hyp = NonNullable<CodeFinding["hypotheses"]>[number];

function hyp(overrides: Partial<Hyp> = {}): Hyp {
  return {
    pattern: "Extract Method",
    layer: "refactorizacion",
    state: "ausente",
    confidence: "media",
    ceiling: "alta",
    provisional: true,
    checks: [],
    discriminators: [],
    places: [],
    toConfirm: [],
    missingCapabilities: [],
    cost: "",
    source: "https://refactoring.com",
    anchorFindingId: "a1",
    ...overrides,
  } as Hyp;
}

describe("familiesIn / filterByFamily", () => {
  const extract = finding({ title: "e1", hypotheses: [hyp({ pattern: "Extract Method" })] });
  const split = finding({ title: "s1", hypotheses: [hyp({ pattern: "Split Phase" })] });
  const ambas = finding({
    title: "e2",
    hypotheses: [hyp({ pattern: "Extract Method" }), hyp({ pattern: "Split Phase" })],
  });
  const lista = [extract, split, ambas];

  it("cuenta TARJETAS, no hipótesis, y ordena de mayor a menor", () => {
    expect(familiesIn(lista, "refactorizacion")).toEqual([
      { pattern: "Extract Method", findings: 2 },
      { pattern: "Split Phase", findings: 2 },
    ]);
  });

  it("un hallazgo que propone la misma familia dos veces cuenta UNA vez", () => {
    const doble = finding({ hypotheses: [hyp({ pattern: "Extract Method" }), hyp({ pattern: "Extract Method" })] });
    expect(familiesIn([doble], "refactorizacion")).toEqual([{ pattern: "Extract Method", findings: 1 }]);
  });

  it("ignora la otra capa — un patrón de diseño no es una familia de refactorización", () => {
    const patron = finding({ hypotheses: [hyp({ pattern: "Facade", layer: "patron" })] });
    expect(familiesIn([patron], "refactorizacion")).toEqual([]);
    expect(familiesIn([patron], "patron")).toEqual([{ pattern: "Facade", findings: 1 }]);
  });

  it("ignora las YA APLICADAS: la lista no las dibuja, así que la opción no puede prometerlas", () => {
    const aplicada = finding({ hypotheses: [hyp({ pattern: "Guard Clauses", state: "ya-aplicado" })] });
    const puenteada = finding({ hypotheses: [hyp({ pattern: "Guard Clauses", state: "aplicado-eludido" })] });
    expect(familiesIn([aplicada, puenteada], "refactorizacion")).toEqual([]);
  });

  it("`null` pasa todo — el filtro apagado no recorta nada (no es paginar)", () => {
    expect(filterByFamily(lista, null, "refactorizacion")).toHaveLength(3);
  });

  it("filtra a los hallazgos que proponen esa familia, incluidos los que proponen varias", () => {
    const soloSplit = filterByFamily(lista, "Split Phase", "refactorizacion");
    expect(soloSplit.map((f) => f.title)).toEqual(["s1", "e2"]);
  });

  it("una familia de la otra capa no arrastra hallazgos de la lista", () => {
    expect(filterByFamily(lista, "Facade", "refactorizacion")).toEqual([]);
  });

  it("la cuenta que la opción promete es la cantidad que el filtro devuelve", () => {
    for (const { pattern, findings } of familiesIn(lista, "refactorizacion")) {
      expect(filterByFamily(lista, pattern, "refactorizacion")).toHaveLength(findings);
    }
  });

  it("un hallazgo sin hipótesis nunca aporta ni pasa un filtro activo", () => {
    const pelado = finding({ title: "pelado" });
    expect(familiesIn([pelado], "refactorizacion")).toEqual([]);
    expect(filterByFamily([pelado], "Extract Method", "refactorizacion")).toEqual([]);
  });
});
