import { describe, expect, it } from "vitest";
import {
  edgeCount,
  formatPct,
  graphHeaderLine,
  graphOf,
  type GraphSummary,
  languageCoverageNote,
  languageCoverageRows,
  symbolCount,
  unresolvedPct,
  unresolvedTotal,
} from "./graph-status";

function graph(overrides: Partial<GraphSummary> = {}): GraphSummary {
  return {
    nodes: 5,
    folders: 1,
    files: 1,
    symbols: 3,
    edges: 2,
    containsEdges: 2,
    referencesEdges: 0,
    resolution: { candidates: 100, resolved: 80, droppedAmbiguous: 15, unresolved: 5 },
    buildMs: 0,
    ...overrides,
  };
}

describe("graphOf", () => {
  it("returns null for an analysis with no graph field yet — today's real state", () => {
    expect(graphOf(null)).toBeNull();
    expect(graphOf(undefined)).toBeNull();
    expect(graphOf({})).toBeNull();
  });

  it("returns the graph when present", () => {
    const g = graph();
    expect(graphOf({ graph: g })).toBe(g);
  });
});

describe("counts", () => {
  it("counts only symbol-kind nodes", () => {
    expect(symbolCount(graph())).toBe(3);
  });

  it("counts edges as-is", () => {
    expect(edgeCount(graph())).toBe(2);
  });
});

describe("unresolvedTotal / unresolvedPct", () => {
  it("sums droppedAmbiguous and unresolved — two different failure shapes, one headline count", () => {
    const resolution = { candidates: 100, resolved: 80, droppedAmbiguous: 15, unresolved: 5 };
    expect(unresolvedTotal(resolution)).toBe(20);
    expect(unresolvedPct(resolution)).toBe(20);
  });

  it("does not divide by zero into NaN when there are no candidates", () => {
    const resolution = { candidates: 0, resolved: 0, droppedAmbiguous: 0, unresolved: 0 };
    expect(unresolvedPct(resolution)).toBe(0);
  });
});

describe("formatPct", () => {
  it("keeps one decimal", () => {
    expect(formatPct(8.13)).toBe("8.1%");
    expect(formatPct(0)).toBe("0.0%");
    expect(formatPct(100)).toBe("100.0%");
  });
});

describe("graphHeaderLine", () => {
  it("renders the exact shape PLAN.md's F3 promises the user", () => {
    const line = graphHeaderLine(graph());
    expect(line).toBe("grafo: 3 símbolos, 2 aristas, 20 referencias sin resolver (20.0%) · 15 por ambigüedad");
  });

  it("omits the ambiguity clause when droppedAmbiguous is zero — never claims a breakdown that has nothing in it", () => {
    const line = graphHeaderLine(
      graph({ resolution: { candidates: 10, resolved: 9, droppedAmbiguous: 0, unresolved: 1 } }),
    );
    expect(line).toBe("grafo: 3 símbolos, 2 aristas, 1 referencias sin resolver (10.0%)");
  });

  it("reads 'no aplicable' rather than a fabricated percentage when there are zero candidates", () => {
    const line = graphHeaderLine(
      graph({ resolution: { candidates: 0, resolved: 0, droppedAmbiguous: 0, unresolved: 0 } }),
    );
    expect(line).toContain("no aplicable");
    expect(line).not.toContain("NaN");
    expect(line).not.toContain("0.0%");
  });

  it("still breaks out droppedAmbiguous even when unresolved alone would already be zero", () => {
    // unresolved (zero-target) can be 0 while droppedAmbiguous (multi-target) is not — jekyll's
    // measured shape, per the F3 write-up ("unresolved da 0 en los 8 ... sólo droppedAmbiguous
    // sobrevive como bucket final real").
    const line = graphHeaderLine(
      graph({ resolution: { candidates: 50, resolved: 34, droppedAmbiguous: 16, unresolved: 0 } }),
    );
    expect(line).toBe("grafo: 3 símbolos, 2 aristas, 16 referencias sin resolver (32.0%) · 16 por ambigüedad");
  });
});

describe("languageCoverageRows", () => {
  it("returns null when no breakdown was supplied — distinct from an empty list", () => {
    expect(languageCoverageRows(graph())).toBeNull();
  });

  it("renders a rate per language when candidates were attempted", () => {
    const rows = languageCoverageRows(
      graph({
        byLanguage: [
          { language: "ruby", candidates: 200, droppedAmbiguous: 16, unresolved: 0 },
          { language: "go", candidates: 300, droppedAmbiguous: 1, unresolved: 0 },
        ],
      }),
    );
    expect(rows).toEqual([
      { kind: "rate", language: "ruby", pct: "8.0%" },
      { kind: "rate", language: "go", pct: "0.3%" },
    ]);
  });

  it("reads 'not-applicable' for a language with zero candidates, never a fabricated 0%", () => {
    const rows = languageCoverageRows(
      graph({ byLanguage: [{ language: "yaml", candidates: 0, droppedAmbiguous: 0, unresolved: 0 }] }),
    );
    expect(rows).toEqual([{ kind: "not-applicable", language: "yaml" }]);
  });
});

describe("languageCoverageNote", () => {
  it("is null for a single-language repo — the top-level line already speaks for it", () => {
    expect(languageCoverageNote(graph(), ["ruby"])).toBeNull();
  });

  it("is null once byLanguage is actually present, regardless of language count", () => {
    expect(languageCoverageNote(graph({ byLanguage: [] }), ["ruby", "go"])).toBeNull();
  });

  it("names the gap for a multi-language repo with no breakdown, instead of staying silent", () => {
    expect(languageCoverageNote(graph(), ["ruby", "go"])).toBe(
      "cobertura por lenguaje: no disponible en este análisis",
    );
  });
});
