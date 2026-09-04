/**
 * "Qué no estamos viendo" — ver coverage.ts para la why.
 */
import { describe, expect, it } from "vitest";
import type { CodeCoverageStatus, CodeDetectorCoverage } from "@shared/types";

import {
  blindSpotLine,
  blindSpotSummary,
  bucketOf,
  groupCoverageByDetector,
  missingCapabilitiesText,
  scopeByKind,
  STATUS_LABELS,
} from "./coverage";

function row(overrides: Partial<CodeDetectorCoverage> = {}): CodeDetectorCoverage {
  return {
    detectorId: "unused-variable",
    title: "Variable sin uso",
    scope: "intra-function",
    kind: "unused-variable",
    language: "java",
    status: "corrio",
    unitsConsidered: 100,
    findings: 12,
    ...overrides,
  };
}

describe("bucketOf", () => {
  it("distingue 'corrió y encontró' de 'corrió y no encontró nada'", () => {
    expect(bucketOf(row({ status: "corrio", findings: 12 }))).toBe("con-hallazgos");
    expect(bucketOf(row({ status: "corrio", findings: 0 }))).toBe("sin-hallazgos");
  });

  it("'no-aplicable' es su propio balde, nunca confundido con cero hallazgos", () => {
    expect(bucketOf(row({ status: "no-aplicable", findings: 0 }))).toBe("no-aplicable");
  });

  it("agrupa sin-grafo y presupuesto-agotado en 'bloqueado'", () => {
    expect(bucketOf(row({ status: "sin-grafo", findings: 0 }))).toBe("bloqueado");
    expect(bucketOf(row({ status: "presupuesto-agotado", findings: 0 }))).toBe("bloqueado");
  });

  it("sin-aristas / sin-metricas también son 'bloqueado', nunca 'sin-hallazgos' — DIAGNÓSTICO-5B §5, Problema 3: hasta esta ola eran indistinguibles de 'corrió, 0 hallazgos'", () => {
    expect(bucketOf(row({ status: "sin-aristas", findings: 0 }))).toBe("bloqueado");
    expect(bucketOf(row({ status: "sin-metricas", findings: 0 }))).toBe("bloqueado");
  });

  it("error es su propio balde", () => {
    expect(bucketOf(row({ status: "error", findings: 0 }))).toBe("error");
  });
});

describe("blindSpotSummary / blindSpotLine", () => {
  it("cuenta cada balde por separado", () => {
    const coverage = [
      row({ language: "java", status: "corrio", findings: 12 }),
      row({ language: "go", status: "corrio", findings: 0 }),
      row({ language: "ruby", status: "no-aplicable", missingCapabilities: ["herencia"] }),
      row({ language: "python", status: "sin-grafo" }),
    ];
    const summary = blindSpotSummary(coverage);
    expect(summary).toEqual({ conHallazgos: 1, sinHallazgos: 1, noAplicable: 1, bloqueado: 1, error: 0, total: 4 });
  });

  it("la frase nunca calla los 'no aplican'", () => {
    const summary = blindSpotSummary([
      row({ status: "corrio", findings: 5 }),
      row({ status: "no-aplicable" }),
    ]);
    const line = blindSpotLine(summary);
    expect(line).toContain("no aplican en su lenguaje");
  });

  it("no fabrica una frase para cobertura vacía", () => {
    expect(blindSpotLine(blindSpotSummary([]))).toBe("Sin datos de cobertura en este análisis.");
  });
});

describe("missingCapabilitiesText", () => {
  it("nunca es null cuando el status es no-aplicable con capacidades declaradas", () => {
    const text = missingCapabilitiesText(row({ status: "no-aplicable", missingCapabilities: ["herencia", "genericos"] }));
    expect(text).toBe("falta: herencia, genericos");
  });

  it("es null cuando no hay capacidades faltantes declaradas", () => {
    expect(missingCapabilitiesText(row({ missingCapabilities: undefined }))).toBeNull();
  });
});

describe("groupCoverageByDetector", () => {
  it("agrupa varias filas de idioma bajo el mismo detector y suma sus hallazgos", () => {
    const coverage = [
      row({ detectorId: "unused-variable", language: "java", findings: 12 }),
      row({ detectorId: "unused-variable", language: "go", findings: 3 }),
      row({ detectorId: "dependency-cycle", language: undefined, scope: "inter-file", findings: 2 }),
    ];
    const groups = groupCoverageByDetector(coverage);
    const unused = groups.find((g) => g.detectorId === "unused-variable")!;
    expect(unused.rows).toHaveLength(2);
    expect(unused.totalFindings).toBe(15);
  });

  it("ordena alfabéticamente por título", () => {
    const coverage = [row({ detectorId: "b", title: "Zeta" }), row({ detectorId: "a", title: "Alfa" })];
    expect(groupCoverageByDetector(coverage).map((g) => g.title)).toEqual(["Alfa", "Zeta"]);
  });
});

describe("STATUS_LABELS", () => {
  it("declara una etiqueta humana para sin-aristas y sin-metricas, no sólo para los cinco status de antes", () => {
    // `Record<CodeCoverageStatus, string>` ya obliga esto en tiempo de
    // compilación (quitar una entrada rompe `tsc`), pero el runtime lo deja
    // explícito para quien lea sólo el test: la etiqueta existe y distingue
    // "sin datos de grafo" de "sin datos de métrica".
    const statuses: readonly CodeCoverageStatus[] = ["sin-aristas", "sin-metricas"];
    for (const s of statuses) {
      expect(STATUS_LABELS[s]).toBeTruthy();
    }
    expect(STATUS_LABELS["sin-aristas"]).not.toBe(STATUS_LABELS["sin-metricas"]);
    expect(STATUS_LABELS["sin-aristas"]).not.toBe(STATUS_LABELS["sin-grafo"]);
  });
});

describe("scopeByKind", () => {
  it("mapea kind -> scope tomando la primera fila que lo declara", () => {
    const coverage = [row({ kind: "unused-variable", scope: "intra-function" })];
    const map = scopeByKind(coverage);
    expect(map.get("unused-variable")).toBe("intra-function");
  });

  it("no tiene entrada para un kind ausente de la cobertura", () => {
    expect(scopeByKind([]).has("unused-variable")).toBe(false);
  });
});
