/**
 * Test de caracterización de `nameGroup`.
 *
 * NO existía antes de la Ola BE: se escribió para poder partir la escalera de
 * tiers sin cambiar ni un nombre. Cada caso fija LOS CUATRO campos del
 * resultado (`name`, `method`, `confidence`, `evidence`), no sólo el nombre:
 * el `method` es lo que dice QUÉ tier ganó, y es justo lo que un corte mal
 * hecho movería sin que el nombre cambie.
 */
import { describe, expect, it } from "vitest";

import { nameGroup, type GroupRelation } from "./group-name";

function rel(from: string, to: string): GroupRelation {
  return { from, to };
}

describe("nameGroup — casos degenerados", () => {
  it("grupo vacío", () => {
    expect(nameGroup([], [])).toEqual({
      name: "Sin nombre",
      method: "empty-group",
      confidence: 0,
      evidence: "",
    });
  });

  it("una sola tabla se humaniza tal cual, sin heurística", () => {
    expect(nameGroup(["form_responses"], [])).toEqual({
      name: "Form Responses",
      method: "single-table",
      confidence: 1,
      evidence: "form_responses",
    });
  });
});

describe("nameGroup — Tier 1: prefijo común", () => {
  it("gana cuando TODAS las tablas comparten el primer token", () => {
    const result = nameGroup(["form_fields", "form_responses", "form_versions"], []);
    expect(result).toEqual({
      name: "Forms",
      method: "common-prefix",
      confidence: 1,
      evidence: "form",
    });
  });

  it("un prefijo de varios tokens se conserva entero", () => {
    const result = nameGroup(["hook_execution_logs", "hook_execution_steps"], []);
    expect(result.method).toBe("common-prefix");
    expect(result.evidence).toBe("hook_execution");
    expect(result.name).toBe("Hook Executions");
  });

  it("una sola tabla sin prefijo compartido lo desarma", () => {
    expect(nameGroup(["form_fields", "deals"], []).method).not.toBe("common-prefix");
  });
});

describe("nameGroup — Tier 2: token singularizado más frecuente", () => {
  it("gana con mayoría simple aunque el prefijo no sea común", () => {
    const result = nameGroup(["deal_stages", "won_deals", "deal_notes"], []);
    expect(result.method).toBe("frequent-token");
    expect(result.evidence).toBe("deal");
    expect(result.name).toBe("Deals");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("el umbral es configurable y decide entre Tier 2 y Tier 3", () => {
    const members = ["deal_stages", "won_deals", "invoices", "payments"];
    const relations = [rel("invoices", "payments"), rel("deal_stages", "payments")];
    expect(nameGroup(members, relations, { tokenCoverageThreshold: 0.4 }).method).toBe(
      "frequent-token",
    );
    expect(nameGroup(members, relations, { tokenCoverageThreshold: 0.9 }).method).toBe(
      "graph-centrality",
    );
  });

  it("el umbral se compara con >=: una cobertura JUSTO en el umbral acepta Tier 2", () => {
    // "deal" cubre 2 de 4 miembros = 0,5 exacto.
    const members = ["deal_stages", "won_deals", "invoices", "payments"];
    const relations = [rel("invoices", "payments"), rel("deal_stages", "payments")];
    const result = nameGroup(members, relations, { tokenCoverageThreshold: 0.5 });
    expect(result.method).toBe("frequent-token");
    expect(result.confidence).toBeCloseTo(0.5, 10);
  });

  it("el umbral por defecto es 0,5 (mayoría simple)", () => {
    const members = ["deal_stages", "won_deals", "invoices", "payments"];
    const relations = [rel("invoices", "payments"), rel("deal_stages", "payments")];
    expect(nameGroup(members, relations)).toEqual(
      nameGroup(members, relations, { tokenCoverageThreshold: 0.5 }),
    );
  });
});

describe("nameGroup — Tier 3: centralidad en el grafo inducido", () => {
  it("gana la tabla con más hijos DENTRO del grupo", () => {
    const members = ["invoices", "payments", "shipments", "customers"];
    const relations = [
      rel("invoices", "customers"),
      rel("payments", "customers"),
      rel("shipments", "customers"),
      rel("payments", "invoices"),
    ];
    const result = nameGroup(members, relations);
    expect(result.method).toBe("graph-centrality");
    expect(result.evidence).toBe("customers");
    expect(result.name).toBe("Customers");
    expect(result.confidence).toBeCloseTo(3 / 4, 10);
  });

  it("filtra internamente las relaciones que salen del grupo", () => {
    const members = ["invoices", "payments", "shipments", "customers"];
    const inside = [
      rel("invoices", "customers"),
      rel("payments", "customers"),
      rel("shipments", "customers"),
      rel("payments", "invoices"),
    ];
    const withOutside = [...inside, rel("logs", "customers"), rel("customers", "tenants")];
    expect(nameGroup(members, withOutside)).toEqual(nameGroup(members, inside));
  });

  it("sin ninguna arista interna sigue devolviendo un nombre, no explota", () => {
    const result = nameGroup(["invoices", "payments", "shipments"], []);
    expect(result.method).toBe("graph-centrality");
    expect(result.name).toBeTruthy();
    expect(result.confidence).toBe(0);
  });
});

describe("nameGroup — orden de los tiers", () => {
  it("Tier 1 le gana a Tier 2 y a Tier 3 aunque los tres apliquen", () => {
    const members = ["deal_stages", "deal_notes", "deal_owners"];
    const relations = [rel("deal_notes", "deal_stages"), rel("deal_owners", "deal_stages")];
    expect(nameGroup(members, relations).method).toBe("common-prefix");
  });

  it("el resultado no depende del orden de los miembros", () => {
    const members = ["invoices", "payments", "shipments", "customers"];
    const relations = [
      rel("invoices", "customers"),
      rel("payments", "customers"),
      rel("shipments", "customers"),
    ];
    expect(nameGroup([...members].reverse(), relations)).toEqual(nameGroup(members, relations));
  });
});
