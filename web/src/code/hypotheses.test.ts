import { describe, expect, it } from "vitest";
import type { CodeFindingHypothesis } from "@shared/types";
import {
  anyDiscriminatorConfirmed,
  atConfidenceCeiling,
  bridgePlaces,
  CONFIDENCE_LABELS,
  formatPlace,
  isNotApplicable,
  isOpenProposal,
  LAYER_LABELS,
  ofLayer,
  openProposals,
  sortHypotheses,
  splitChecks,
  stateMeta,
} from "./hypotheses";

/** Shape lifted from a real run (`aplicado-eludido`/Facade, this same repo, F7 verification). */
function facadeHypothesis(overrides: Partial<CodeFindingHypothesis> = {}): CodeFindingHypothesis {
  return {
    pattern: "Facade",
    layer: "patron",
    state: "aplicado-eludido",
    confidence: null,
    ceiling: "media",
    provisional: true,
    checks: [
      { label: "Fan-out interno >= 4 colaboradores distintos.", passed: true, why: "28 colaboradores.", role: "required" },
      { label: "Al menos un archivo externo referencia a este candidato.", passed: true, why: "Referenciado por 22 archivos.", role: "required" },
      { label: "Algún cliente externo puentea directamente.", passed: true, why: "14 fugas.", role: "applied" },
    ],
    discriminators: [
      { label: "Agrupamiento <= 0.2.", passed: true, why: "0.14.", role: "discriminator" },
      { label: "Fan-out es el máximo del repo.", passed: true, why: "28 vs 28.", role: "discriminator" },
    ],
    places: [
      { file: "src/code-analyzer.ts", startLine: 1, endLine: 2641, role: "archivo candidato a fachada: fan-out interno alto, coordinado por clientes externos" },
      { file: "scripts/language-coverage.mts", startLine: 1, endLine: 5, role: "cliente que puentea la fachada" },
      { file: "web/src/code/CodePanel.vue", startLine: 1, endLine: 5, role: "colaborador interno alcanzado directamente, sin pasar por la fachada" },
    ],
    toConfirm: ["¿Los colaboradores son un subsistema coherente?"],
    cost: "Una clase más para mantener sincronizada.",
    source: "https://refactoring.guru/es/design-patterns/facade",
    missingCapabilities: [],
    anchorFindingId: "fanout-without-cohesion:abc",
    ...overrides,
  };
}

describe("stateMeta", () => {
  it("da el sello EXACTO de cada uno de los cuatro estados — CONTRATO-F7.md §1.2", () => {
    expect(stateMeta("aplicado-eludido").label).toBe("PATRÓN PUENTEADO");
    expect(stateMeta("aplicado-eludido").icon).toBe("⚡");
    expect(stateMeta("aplicado-eludido").defaultOpen).toBe(true);
    expect(stateMeta("aplicado-eludido").order).toBe(1);

    expect(stateMeta("parcial").label).toBe("Parcial");
    expect(stateMeta("parcial").defaultOpen).toBe(false);
    expect(stateMeta("parcial").order).toBe(2);

    expect(stateMeta("ausente").label).toBe("Falta el patrón");
    expect(stateMeta("ausente").order).toBe(3);

    expect(stateMeta("ya-aplicado").label).toBe("Ya aplicado");
    expect(stateMeta("ya-aplicado").order).toBe(4);
  });

  it("sólo aplicado-eludido está abierto por defecto", () => {
    expect(stateMeta("aplicado-eludido").defaultOpen).toBe(true);
    expect(stateMeta("parcial").defaultOpen).toBe(false);
    expect(stateMeta("ausente").defaultOpen).toBe(false);
    expect(stateMeta("ya-aplicado").defaultOpen).toBe(false);
  });
});

describe("isNotApplicable", () => {
  it("missingCapabilities no vacío ⇒ no aplicable, sin importar el state", () => {
    const h = facadeHypothesis({ state: "ausente", confidence: null, missingCapabilities: ["unidad-tipo-clase"] });
    expect(isNotApplicable(h)).toBe(true);
  });

  it("missingCapabilities vacío ⇒ es uno de los cuatro estados", () => {
    expect(isNotApplicable(facadeHypothesis())).toBe(false);
  });
});

describe("splitChecks", () => {
  it("separa requisitos (checks) de lo-que-sube-la-confianza (discriminators)", () => {
    const h = facadeHypothesis();
    const { requirements, discriminators } = splitChecks(h);
    expect(requirements).toBe(h.checks);
    expect(discriminators).toBe(h.discriminators);
    expect(requirements.map((c) => c.role)).toEqual(["required", "required", "applied"]);
  });
});

describe("anyDiscriminatorConfirmed", () => {
  it("false cuando ningún discriminador pasó — dispara 'nada subió la confianza'", () => {
    const h = facadeHypothesis({
      discriminators: [{ label: "x", passed: false, why: "no", role: "discriminator" }],
    });
    expect(anyDiscriminatorConfirmed(h)).toBe(false);
  });

  it("true cuando al menos uno pasó", () => {
    expect(anyDiscriminatorConfirmed(facadeHypothesis())).toBe(true);
  });
});

describe("atConfidenceCeiling", () => {
  it("false cuando confidence es null (aplicado-eludido/ya-aplicado, por diseño)", () => {
    expect(atConfidenceCeiling(facadeHypothesis({ confidence: null, ceiling: "media" }))).toBe(false);
  });

  it("true cuando confidence === ceiling", () => {
    expect(
      atConfidenceCeiling(facadeHypothesis({ state: "ausente", confidence: "media", ceiling: "media" })),
    ).toBe(true);
  });

  it("false cuando confidence < ceiling", () => {
    expect(
      atConfidenceCeiling(facadeHypothesis({ state: "ausente", confidence: "baja", ceiling: "media" })),
    ).toBe(false);
  });
});

describe("bridgePlaces", () => {
  it("filtra por los roles REALES de facade.ts — 'puentea' / 'directamente' — y nada más", () => {
    const h = facadeHypothesis();
    const bridges = bridgePlaces(h);
    expect(bridges).toHaveLength(2);
    expect(bridges.map((p) => p.file)).toEqual(["scripts/language-coverage.mts", "web/src/code/CodePanel.vue"]);
  });

  it("un place que no es fuga (el propio candidato) no entra", () => {
    const h = facadeHypothesis({
      places: [{ file: "a.ts", startLine: 1, endLine: 1, role: "archivo candidato a fachada" }],
    });
    expect(bridgePlaces(h)).toHaveLength(0);
  });
});

describe("sortHypotheses", () => {
  it("aplicado-eludido primero, ya-aplicado último, no-aplicable al final de todo", () => {
    const notApplicable = facadeHypothesis({ pattern: "Proxy", state: "ausente", confidence: null, missingCapabilities: ["unidad-tipo-clase"] });
    const applied = facadeHypothesis({ pattern: "Iterator", state: "ya-aplicado", confidence: null });
    const partial = facadeHypothesis({ pattern: "Builder", state: "parcial", confidence: "baja" });
    const bridged = facadeHypothesis({ pattern: "Facade", state: "aplicado-eludido" });
    const absent = facadeHypothesis({ pattern: "Strategy", state: "ausente", confidence: "media" });

    const sorted = sortHypotheses([notApplicable, applied, partial, bridged, absent]);
    expect(sorted.map((h) => h.pattern)).toEqual(["Facade", "Builder", "Strategy", "Iterator", "Proxy"]);
  });

  it("desempata por índice original, nunca por un re-sort implícito", () => {
    const a = facadeHypothesis({ pattern: "A", state: "ausente", confidence: "baja" });
    const b = facadeHypothesis({ pattern: "B", state: "ausente", confidence: "baja" });
    expect(sortHypotheses([a, b]).map((h) => h.pattern)).toEqual(["A", "B"]);
    expect(sortHypotheses([b, a]).map((h) => h.pattern)).toEqual(["B", "A"]);
  });
});

/** F-RETIRO-VÍA-VIEJA: movidas de `opportunities.test.ts` (retirado) — `CONFIDENCE_LABELS`/`formatPlace` migraron a `hypotheses.ts`, ver su docstring. */
describe("CONFIDENCE_LABELS", () => {
  it("trae una etiqueta en español para las tres confianzas", () => {
    expect(CONFIDENCE_LABELS).toEqual({ alta: "Alta", media: "Media", baja: "Baja" });
  });
});

describe("formatPlace", () => {
  it("renders a single line as file:line — role", () => {
    expect(formatPlace({ file: "a.rb", startLine: 5, endLine: 5, role: "acumulador" })).toBe(
      "a.rb:5 — acumulador",
    );
  });

  it("renders a span as file:start-end — role", () => {
    expect(formatPlace({ file: "a.rb", startLine: 5, endLine: 20, role: "guardia #2" })).toBe(
      "a.rb:5-20 — guardia #2",
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * CAPA — OLA BA, FRENTE BA2.
 * ──────────────────────────────────────────────────────────────────────── */

describe("ofLayer", () => {
  it("parte las dos capas y no deja ninguna hipótesis afuera", () => {
    const list = [
      facadeHypothesis({ pattern: "Facade", layer: "patron" }),
      facadeHypothesis({ pattern: "Extract Method", layer: "refactorizacion" }),
      facadeHypothesis({ pattern: "Guard Clauses", layer: "refactorizacion" }),
    ];
    const patrones = ofLayer(list, "patron");
    const refactorizaciones = ofLayer(list, "refactorizacion");
    expect(patrones.map((h) => h.pattern)).toEqual(["Facade"]);
    expect(refactorizaciones.map((h) => h.pattern)).toEqual(["Extract Method", "Guard Clauses"]);
    expect(patrones.length + refactorizaciones.length).toBe(list.length);
  });

  it("NO deriva la capa del nombre: un nombre con paréntesis marcado como refactorización sale por refactorización", () => {
    // El catálogo publica literalmente "Proxy (inicialización perezosa)" y
    // "Extract Class (campos temporales)" — cualquier separación escrita por
    // nombre ya nace rota. Estas dos entradas tienen la capa CRUZADA a
    // propósito respecto de lo que sugiere su nombre: si el filtro mirara el
    // texto, este test se pondría rojo.
    const list = [
      facadeHypothesis({ pattern: "Proxy (inicialización perezosa)", layer: "refactorizacion" }),
      facadeHypothesis({ pattern: "Extract Class (campos temporales)", layer: "patron" }),
    ];
    expect(ofLayer(list, "patron").map((h) => h.pattern)).toEqual(["Extract Class (campos temporales)"]);
    expect(ofLayer(list, "refactorizacion").map((h) => h.pattern)).toEqual(["Proxy (inicialización perezosa)"]);
  });

  it("conserva el orden de entrada — el orden lo decide quien llama, no el filtro", () => {
    const list = [
      facadeHypothesis({ pattern: "Strategy", layer: "patron" }),
      facadeHypothesis({ pattern: "Command", layer: "patron" }),
    ];
    expect(ofLayer(list, "patron").map((h) => h.pattern)).toEqual(["Strategy", "Command"]);
  });

  it("lista vacía en una capa sin miembros — nunca `undefined`", () => {
    expect(ofLayer([facadeHypothesis({ layer: "patron" })], "refactorizacion")).toEqual([]);
  });
});

describe("LAYER_LABELS", () => {
  it("tiene una etiqueta humana para cada una de las dos capas", () => {
    expect(LAYER_LABELS).toEqual({ patron: "Patrón de diseño", refactorizacion: "Refactorización" });
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * OLA BB, FRENTE BB2 — "Sácalos de la lista, que queden solo en Arquitectura"
 * (pedido textual). La lista principal dibuja sólo las hipótesis ABIERTAS.
 * ──────────────────────────────────────────────────────────────────────── */
describe("isOpenProposal / openProposals", () => {
  it("`ausente` y `parcial` SON recomendaciones — se dibujan en la lista", () => {
    expect(isOpenProposal(facadeHypothesis({ state: "ausente" }))).toBe(true);
    expect(isOpenProposal(facadeHypothesis({ state: "parcial" }))).toBe(true);
  });

  it("`ya-aplicado` y `aplicado-eludido` NO — su lugar es Arquitectura", () => {
    expect(isOpenProposal(facadeHypothesis({ state: "ya-aplicado" }))).toBe(false);
    expect(isOpenProposal(facadeHypothesis({ state: "aplicado-eludido" }))).toBe(false);
  });

  it("es el COMPLEMENTO EXACTO de los dos estados aplicados — ni un estado cae de las dos vistas", () => {
    const estados = ["ausente", "parcial", "ya-aplicado", "aplicado-eludido"] as const;
    const abiertos = estados.filter((state) => isOpenProposal(facadeHypothesis({ state })));
    const aplicados = estados.filter((state) => !isOpenProposal(facadeHypothesis({ state })));
    expect([...abiertos, ...aplicados].sort()).toEqual([...estados].sort());
    expect(aplicados).toEqual(["ya-aplicado", "aplicado-eludido"]);
  });

  it("un estado desconocido cae del lado VISIBLE — desaparecer en silencio es el modo de falla que estamos evitando", () => {
    const raro = { ...facadeHypothesis(), state: "un-estado-nuevo" } as unknown as CodeFindingHypothesis;
    expect(isOpenProposal(raro)).toBe(true);
  });

  it("`openProposals` conserva el orden de entrada y no muta", () => {
    const list = [
      facadeHypothesis({ pattern: "A", state: "ausente" }),
      facadeHypothesis({ pattern: "B", state: "ya-aplicado" }),
      facadeHypothesis({ pattern: "C", state: "parcial" }),
    ];
    const copia = [...list];
    expect(openProposals(list).map((h) => h.pattern)).toEqual(["A", "C"]);
    expect(list).toEqual(copia);
  });
});
