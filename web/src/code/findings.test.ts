/**
 * Ranking/formatting rules for code hotspots — see findings.ts for the why.
 */
import { describe, expect, it } from "vitest";
import type { CodeFinding } from "@shared/types";

import {
  countsByKind,
  filterFindings,
  findingKey,
  formatLocation,
  KIND_ORDER,
  kindLabel,
  kindsByVolume,
  orderedKinds,
  rankFindings,
  severityTier,
} from "./findings";

/** A minimal finding, only overriding what a test cares about. */
function finding(overrides: Partial<CodeFinding> = {}): CodeFinding {
  return {
    kind: "complexity",
    title: "Función compleja",
    detail: "detalle",
    metric: { label: "Ramas", value: 12 },
    severity: 50,
    locations: [{ file: "app/models/order.rb", startLine: 10, endLine: 40 }],
    ...overrides,
  };
}

describe("rankFindings", () => {
  it("orders by severity, highest first", () => {
    const findings = [finding({ severity: 30 }), finding({ severity: 90 }), finding({ severity: 60 })];
    expect(rankFindings(findings).map((f) => f.severity)).toEqual([90, 60, 30]);
  });

  it("breaks ties by original order, never reshuffling equal severities", () => {
    const a = finding({ severity: 50, title: "a" });
    const b = finding({ severity: 50, title: "b" });
    const c = finding({ severity: 50, title: "c" });
    expect(rankFindings([a, b, c]).map((f) => f.title)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const input = [finding({ severity: 10 }), finding({ severity: 90 })];
    const copy = [...input];
    rankFindings(input);
    expect(input).toEqual(copy);
  });
});

describe("filterFindings", () => {
  const findings = [
    finding({ kind: "duplication" }),
    finding({ kind: "complexity" }),
    finding({ kind: "long-function" }),
  ];

  it("returns everything when the filter is null", () => {
    expect(filterFindings(findings, null)).toHaveLength(3);
  });

  it("keeps only the matching kind otherwise", () => {
    const result = filterFindings(findings, "complexity");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("complexity");
  });
});

describe("countsByKind", () => {
  it("zero-fills every kind, including ones absent from the input", () => {
    const findings = [finding({ kind: "duplication" }), finding({ kind: "duplication" })];
    expect(countsByKind(findings)).toMatchObject({
      duplication: 2,
      "conditional-chain": 0,
      complexity: 0,
      "long-function": 0,
    });
  });

  it("returns all zeros for an empty analysis", () => {
    expect(countsByKind([])).toMatchObject({
      duplication: 0,
      "conditional-chain": 0,
      complexity: 0,
      "long-function": 0,
    });
  });
});

/**
 * La unión de kinds es ABIERTA: un detector nuevo emite un kind que este
 * frontend nunca vio. Estos tests son la garantía de que eso no rompe nada —
 * ni la fila de totales, ni el filtro, ni las tarjetas.
 */
describe("unión abierta de kinds", () => {
  it("kindLabel usa el catálogo del payload cuando el kind es desconocido", () => {
    expect(kindLabel("shotgun-surgery", [{ kind: "shotgun-surgery", label: "Cirugía con escopeta" }])).toBe(
      "Cirugía con escopeta",
    );
  });

  it("kindLabel cae a la etiqueta legada cuando no hay catálogo (análisis cacheado)", () => {
    expect(kindLabel("duplication")).toBe("Duplicación");
  });

  it("kindLabel humaniza el slug cuando no hay ni catálogo ni etiqueta legada", () => {
    expect(kindLabel("shotgun-surgery")).toBe("Shotgun surgery");
  });

  it("kindLabel prefiere el catálogo por sobre la etiqueta legada", () => {
    expect(kindLabel("duplication", [{ kind: "duplication", label: "Código repetido" }])).toBe(
      "Código repetido",
    );
  });

  it("orderedKinds mantiene los legados primero, en su orden fijo", () => {
    expect(orderedKinds([]).slice(0, KIND_ORDER.length)).toEqual(KIND_ORDER);
  });

  it("orderedKinds agrega los kinds del catálogo después de los legados, sin duplicar", () => {
    const ordered = orderedKinds([], [
      { kind: "duplication", label: "Duplicación" },
      { kind: "god-object", label: "Objeto Dios" },
    ]);
    expect(ordered.filter((k) => k === "duplication")).toHaveLength(1);
    expect(ordered[ordered.length - 1]).toBe("god-object");
  });

  it("orderedKinds rescata un kind presente en los hallazgos que no está en ninguna lista", () => {
    const ordered = orderedKinds([finding({ kind: "feature-envy" })]);
    expect(ordered).toContain("feature-envy");
  });

  it("countsByKind cuenta un kind desconocido en vez de producir NaN", () => {
    const counts = countsByKind([finding({ kind: "feature-envy" }), finding({ kind: "feature-envy" })]);
    expect(counts["feature-envy"]).toBe(2);
    expect(counts.duplication).toBe(0);
  });
});

describe("severityTier", () => {
  it.each([
    [100, "high"],
    [70, "high"],
    [69, "medium"],
    [40, "medium"],
    [39, "low"],
    [0, "low"],
  ] as const)("severity %i is %s", (severity, tier) => {
    expect(severityTier(severity)).toBe(tier);
  });
});

describe("formatLocation", () => {
  it("renders a single line as file:line", () => {
    expect(formatLocation({ file: "a.rb", startLine: 5, endLine: 5 })).toBe("a.rb:5");
  });

  it("renders a span as file:start-end", () => {
    expect(formatLocation({ file: "a.rb", startLine: 5, endLine: 20 })).toBe("a.rb:5-20");
  });

  it("appends the enclosing symbol when present", () => {
    expect(
      formatLocation({ file: "a.rb", startLine: 5, endLine: 20, symbol: "charge!" }),
    ).toBe("a.rb:5-20 (charge!)");
  });
});

describe("findingKey", () => {
  it("differs for findings with different first locations", () => {
    const a = finding({ locations: [{ file: "a.rb", startLine: 1, endLine: 1 }] });
    const b = finding({ locations: [{ file: "b.rb", startLine: 1, endLine: 1 }] });
    expect(findingKey(a)).not.toBe(findingKey(b));
  });

  it("tolerates a finding with no locations", () => {
    expect(() => findingKey(finding({ locations: [] }))).not.toThrow();
  });
});

/**
 * OLA BB, FRENTE BB2 — "Ordenaría los kinds por cantidad" (pedido textual).
 */
describe("kindsByVolume", () => {
  it("ordena de mayor a menor cantidad, sin importar el orden de catálogo", () => {
    const ordered = kindsByVolume(
      ["duplication", "conditional-chain", "complexity", "long-function"],
      { duplication: 1023, "conditional-chain": 75, complexity: 647, "long-function": 1684 },
    );
    expect(ordered).toEqual(["long-function", "duplication", "complexity", "conditional-chain"]);
  });

  it("manda los kinds en cero al final, sin borrarlos — que un detector corriera y no encontrara nada es un dato", () => {
    const ordered = kindsByVolume(["a", "b", "c"], { a: 0, b: 5, c: 0 });
    expect(ordered).toEqual(["b", "a", "c"]);
    expect(ordered).toHaveLength(3);
  });

  it("un kind sin entrada en las cuentas vale 0, nunca NaN (no se cuela al frente)", () => {
    const ordered = kindsByVolume(["fantasma", "duplication"], { duplication: 3 });
    expect(ordered).toEqual(["duplication", "fantasma"]);
  });

  it("desempata por la posición de catálogo, nunca por que Array.sort sea estable", () => {
    const catalogo = ["z", "m", "a"];
    expect(kindsByVolume(catalogo, { z: 7, m: 7, a: 7 })).toEqual(catalogo);
  });

  it("no muta la lista que recibe", () => {
    const catalogo = ["a", "b"];
    const copia = [...catalogo];
    kindsByVolume(catalogo, { a: 1, b: 9 });
    expect(catalogo).toEqual(copia);
  });
});
