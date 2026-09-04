/**
 * Lógica de las tres pestañas nuevas — ver tabs.ts para la why. Formas
 * calcadas de una self-analysis real de este mismo repo (ver el reporte de
 * la tarea): patrones "Facade"/"Strategy", roles reales de `facade.ts`
 * ("cliente que puentea la fachada", "colaborador interno alcanzado
 * directamente, sin pasar por la fachada"), y una `graph.resolution` con
 * candidatos/resueltos/ambiguos/sin-resolver de un tamaño real.
 */
import { describe, expect, it } from "vitest";
import type { CodeAnalysis, CodeFileSummary, CodeFinding } from "@shared/types";
import type { CodeFindingHypothesis } from "@shared/types";

import {
  bridgeLeaks,
  collectAppliedHypotheses,
  collectHypothesesOfLayer,
  collectResolvedHypotheses,
  discardedItems,
  hypothesisAnchorFile,
  folderLabel,
  folderOf,
  groupByPattern,
  RESOLVED_GAP_SHAPE,
  resolutionSummary,
  topFoldersByImpact,
  topFoldersByLines,
} from "./tabs";

function hypothesis(overrides: Partial<CodeFindingHypothesis> = {}): CodeFindingHypothesis {
  return {
    pattern: "Strategy",
    layer: "patron",
    state: "ausente",
    confidence: "baja",
    ceiling: "media",
    provisional: true,
    checks: [],
    discriminators: [],
    places: [],
    toConfirm: [],
    cost: "",
    source: "https://refactoring.guru/design-patterns/strategy",
    missingCapabilities: [],
    anchorFindingId: "f1",
    ...overrides,
  };
}

function finding(overrides: Partial<CodeFinding> = {}): CodeFinding {
  return {
    id: "f1",
    kind: "conditional-chain",
    title: "render() decide por tipo de nodo en 6 ramas encadenadas",
    detail: "",
    metric: { label: "ramas", value: 6 },
    severity: 78,
    locations: [{ file: "web/src/render/paint.ts", startLine: 112, endLine: 198 }],
    ...overrides,
  };
}

function analysis(overrides: Partial<CodeAnalysis> = {}): CodeAnalysis {
  return {
    repoName: "claude-kanban",
    scannedFiles: 2,
    analysedFiles: 2,
    totalLines: 300,
    languages: ["typescript"],
    files: [
      { path: "web/src/render/paint.ts", lines: 200, language: "typescript" },
      { path: "web/src/render/registry.ts", lines: 100, language: "typescript" },
    ],
    findings: [finding()],
    ...overrides,
  };
}

describe("collectAppliedHypotheses / groupByPattern", () => {
  it("filtra por defecto sólo aplicado-eludido y ya-aplicado — ausente/parcial no compiten acá", () => {
    const f = finding({
      hypotheses: [
        hypothesis({ pattern: "Strategy", state: "ausente" }),
        hypothesis({ pattern: "Facade", state: "aplicado-eludido" }),
        hypothesis({ pattern: "Command", state: "ya-aplicado" }),
        hypothesis({ pattern: "Builder", state: "parcial" }),
      ],
    });
    const applied = collectAppliedHypotheses(analysis({ findings: [f] }));
    expect(applied.map((a) => a.hypothesis.pattern).sort()).toEqual(["Command", "Facade"]);
  });

  it("aplicado-eludido primero, con desempate alfabético por patrón", () => {
    const f = finding({
      hypotheses: [
        hypothesis({ pattern: "Strategy", state: "ya-aplicado", anchorFindingId: "a" }),
        hypothesis({ pattern: "Facade", state: "aplicado-eludido", anchorFindingId: "b" }),
      ],
    });
    const applied = collectAppliedHypotheses(analysis({ findings: [f] }));
    expect(applied[0]!.hypothesis.state).toBe("aplicado-eludido");
    expect(applied[1]!.hypothesis.state).toBe("ya-aplicado");
  });

  it("agrupa por pattern y pone arriba los grupos con alguna aplicado-eludido", () => {
    const f1 = finding({ id: "f1", hypotheses: [hypothesis({ pattern: "Command", state: "ya-aplicado", anchorFindingId: "f1" })] });
    const f2 = finding({ id: "f2", hypotheses: [hypothesis({ pattern: "Facade", state: "aplicado-eludido", anchorFindingId: "f2" })] });
    const groups = groupByPattern(collectAppliedHypotheses(analysis({ findings: [f1, f2] })));
    expect(groups[0]!.pattern).toBe("Facade");
    expect(groups[0]!.hasBridged).toBe(true);
    expect(groups[1]!.pattern).toBe("Command");
    expect(groups[1]!.hasBridged).toBe(false);
  });
});

describe("bridgeLeaks", () => {
  it("cuenta sólo los places cuyo role es uno de los dos roles reales de facade.ts", () => {
    const h = hypothesis({
      pattern: "Facade",
      state: "aplicado-eludido",
      places: [
        { file: "a.ts", startLine: 1, endLine: 1, role: "archivo candidato a fachada: fan-out interno alto" },
        { file: "b.ts", startLine: 1, endLine: 1, role: "cliente que puentea la fachada" },
        { file: "c.ts", startLine: 1, endLine: 1, role: "colaborador interno alcanzado directamente, sin pasar por la fachada" },
      ],
    });
    expect(bridgeLeaks(h)).toHaveLength(2);
  });

  it("da 0 (no un error) cuando el patrón no usa esos roles — p. ej. Strategy sobre repeticiones", () => {
    const h = hypothesis({
      pattern: "Strategy",
      state: "aplicado-eludido",
      places: [{ file: "x.ts", startLine: 1, endLine: 1, role: "repetición #1" }],
    });
    expect(bridgeLeaks(h)).toHaveLength(0);
  });
});

describe("folderOf / folderLabel", () => {
  it("carpeta contenedora; raíz explícita, nunca una fila vacía", () => {
    expect(folderOf("web/src/code/tabs.ts")).toBe("web/src/code");
    expect(folderOf("README.md")).toBe("");
    expect(folderLabel("")).toBe("(raíz)");
    expect(folderLabel("web/src/code")).toBe("web/src/code");
  });
});

describe("topFoldersByLines", () => {
  it("suma líneas por carpeta, mayor primero", () => {
    const files: CodeFileSummary[] = [
      { path: "a/one.ts", lines: 100, language: "typescript" },
      { path: "a/two.ts", lines: 50, language: "typescript" },
      { path: "b/three.ts", lines: 500, language: "typescript" },
    ];
    const top = topFoldersByLines(files);
    expect(top[0]).toEqual({ folder: "b", value: 500, files: 1 });
    expect(top[1]).toEqual({ folder: "a", value: 150, files: 2 });
  });
});

describe("topFoldersByImpact", () => {
  it("usa score si está, si no severity/100, multiplicado por memberCount", () => {
    const files: CodeFileSummary[] = [{ path: "a/one.ts", lines: 10, language: "typescript" }];
    const f = finding({ locations: [{ file: "a/one.ts", startLine: 1, endLine: 1 }], score: 0.5, memberCount: 4 });
    const top = topFoldersByImpact(files, [f]);
    expect(top[0]!.folder).toBe("a");
    expect(top[0]!.value).toBeCloseTo(2, 5);
  });

  it("un hallazgo con locations en dos carpetas suma su impacto en las dos", () => {
    const files: CodeFileSummary[] = [
      { path: "a/one.ts", lines: 10, language: "typescript" },
      { path: "b/two.ts", lines: 10, language: "typescript" },
    ];
    const f = finding({
      locations: [
        { file: "a/one.ts", startLine: 1, endLine: 1 },
        { file: "b/two.ts", startLine: 1, endLine: 1 },
      ],
      severity: 100,
    });
    const top = topFoldersByImpact(files, [f]);
    expect(top.map((t) => t.folder).sort()).toEqual(["a", "b"]);
    expect(top[0]!.value).toBeCloseTo(1, 5);
  });
});

describe("resolutionSummary", () => {
  it("null sin grafo o sin candidatos — nunca un 0% fabricado", () => {
    expect(resolutionSummary(undefined)).toBeNull();
    expect(
      resolutionSummary({
        nodes: 0, folders: 0, files: 0, symbols: 0, edges: 0, containsEdges: 0, referencesEdges: 0,
        resolution: { candidates: 0, resolved: 0, droppedAmbiguous: 0, unresolved: 0 },
        buildMs: 0,
      }),
    ).toBeNull();
  });

  it("porcentajes y frase con los números reales — calcado de una corrida real", () => {
    const s = resolutionSummary({
      nodes: 5824, folders: 31, files: 218, symbols: 5575, edges: 13112, containsEdges: 6404, referencesEdges: 6573,
      resolution: { candidates: 37931, resolved: 6719, droppedAmbiguous: 976, unresolved: 0 },
      buildMs: 191.9,
    });
    expect(s).not.toBeNull();
    expect(s!.pctResolved).toBe(18);
    expect(s!.sentence).toContain("37.931");
    expect(s!.sentence).toContain("6.719");
    expect(s!.sentence).toContain("18%");
    expect(s!.sentence).toContain("976");
  });
});

describe("discardedItems", () => {
  it("junta findings descartados, más reciente primero", () => {
    const f1 = finding({ id: "f1", discarded: { reason: "falso positivo", decidedAt: "2026-07-01T00:00:00.000Z" } });
    const f2 = finding({ id: "f2", discarded: { reason: "no aplica acá", decidedAt: "2026-07-15T00:00:00.000Z" } });
    const items = discardedItems(analysis({ findings: [f1, f2] }));
    expect(items).toHaveLength(2);
    expect(items[0]!.itemKind).toBe("finding");
    expect(items[0]!.discarded.reason).toBe("no aplica acá");
    expect(items[1]!.itemKind).toBe("finding");
  });

  it("ignora los que no están descartados", () => {
    const items = discardedItems(analysis({ findings: [finding({ id: "f1" })] }));
    expect(items).toHaveLength(0);
  });

  it("sin id no se puede discard/restore por contrato F2 — se excluye aunque traiga `discarded`", () => {
    const f = finding({ id: undefined, discarded: { reason: "x", decidedAt: "2026-01-01T00:00:00.000Z" } });
    expect(discardedItems(analysis({ findings: [f] }))).toHaveLength(0);
  });
});

describe("collectResolvedHypotheses", () => {
  it("sólo ya-aplicado — aplicado-eludido NO cuenta como resuelto (todavía se puentea)", () => {
    const f = finding({
      hypotheses: [
        hypothesis({ pattern: "Facade", state: "aplicado-eludido" }),
        hypothesis({ pattern: "Command", state: "ya-aplicado" }),
      ],
    });
    const resolved = collectResolvedHypotheses(analysis({ findings: [f] }));
    expect(resolved.map((r) => r.hypothesis.pattern)).toEqual(["Command"]);
  });
});

describe("RESOLVED_GAP_SHAPE", () => {
  it("declara la forma exacta del dato que falta, no un campo inventado en el payload", () => {
    expect(RESOLVED_GAP_SHAPE).toBe("{ analysedAt: string; findingIds: string[] }");
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * La pestaña "Patrones" — OLA BA, FRENTE BA2.
 * ──────────────────────────────────────────────────────────────────────── */

describe("collectHypothesesOfLayer", () => {
  it("trae SÓLO la capa pedida, con el hallazgo ancla pegado", () => {
    const f = finding({
      hypotheses: [
        hypothesis({ pattern: "Facade", layer: "patron", anchorFindingId: "f1" }),
        hypothesis({ pattern: "Extract Method", layer: "refactorizacion", anchorFindingId: "f1" }),
      ],
    });
    const patrones = collectHypothesesOfLayer([f], "patron");
    expect(patrones.map((i) => i.hypothesis.pattern)).toEqual(["Facade"]);
    expect(patrones[0]!.finding).toBe(f);
  });

  it("trae TODOS los estados, no sólo los dos «ya existe» de collectAppliedHypotheses", () => {
    const f = finding({
      hypotheses: [
        hypothesis({ pattern: "Strategy", state: "ausente", anchorFindingId: "a" }),
        hypothesis({ pattern: "Strategy", state: "parcial", anchorFindingId: "b" }),
        hypothesis({ pattern: "Strategy", state: "ya-aplicado", anchorFindingId: "c" }),
        hypothesis({ pattern: "Strategy", state: "aplicado-eludido", anchorFindingId: "d" }),
      ],
    });
    expect(collectHypothesesOfLayer([f], "patron")).toHaveLength(4);
    // La compuerta: el colector viejo, sobre el MISMO hallazgo, trae 2.
    expect(collectAppliedHypotheses(analysis({ findings: [f] }))).toHaveLength(2);
  });

  it("ordena por estado (aplicado-eludido primero), después patrón, después ancla — nunca el orden de llegada", () => {
    const f = finding({
      hypotheses: [
        hypothesis({ pattern: "Strategy", state: "ausente", anchorFindingId: "z" }),
        hypothesis({ pattern: "Command", state: "ausente", anchorFindingId: "b" }),
        hypothesis({ pattern: "Command", state: "ausente", anchorFindingId: "a" }),
        hypothesis({ pattern: "Facade", state: "aplicado-eludido", anchorFindingId: "y" }),
      ],
    });
    expect(
      collectHypothesesOfLayer([f], "patron").map((i) => `${i.hypothesis.pattern}:${i.hypothesis.anchorFindingId}`),
    ).toEqual(["Facade:y", "Command:a", "Command:b", "Strategy:z"]);
  });

  it("cruza hallazgos: junta las hipótesis de la capa de TODOS los hallazgos que se le pasan", () => {
    const a = finding({ id: "f1", hypotheses: [hypothesis({ pattern: "Builder", anchorFindingId: "f1" })] });
    const b = finding({ id: "f2", hypotheses: [hypothesis({ pattern: "Adapter", anchorFindingId: "f2" })] });
    expect(collectHypothesesOfLayer([a, b], "patron").map((i) => i.hypothesis.pattern)).toEqual([
      "Adapter",
      "Builder",
    ]);
  });

  it("un hallazgo sin hipótesis no aporta nada y no explota", () => {
    expect(collectHypothesesOfLayer([finding({ hypotheses: undefined })], "patron")).toEqual([]);
  });
});

describe("hypothesisAnchorFile", () => {
  it("prefiere el primer `place` de la hipótesis", () => {
    const item = {
      finding: finding(),
      hypothesis: hypothesis({
        places: [{ file: "src/factory.ts", startLine: 1, endLine: 9, role: "candidato" }],
      }),
    };
    expect(hypothesisAnchorFile(item)).toBe("src/factory.ts");
  });

  it("cae a la primera ubicación del hallazgo ancla cuando la hipótesis no tiene lugares", () => {
    expect(hypothesisAnchorFile({ finding: finding(), hypothesis: hypothesis({ places: [] }) })).toBe(
      "web/src/render/paint.ts",
    );
  });

  it("`null` cuando no hay ni lugares ni ubicaciones — nunca un archivo inventado", () => {
    expect(
      hypothesisAnchorFile({ finding: finding({ locations: [] }), hypothesis: hypothesis({ places: [] }) }),
    ).toBeNull();
  });
});
