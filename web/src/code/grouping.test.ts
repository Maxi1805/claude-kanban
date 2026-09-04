/**
 * Agrupación por localidad + honestidad de volumen — ver grouping.ts para la why.
 */
import { describe, expect, it } from "vitest";
import type { CodeFinding } from "@shared/types";

import {
  groupFindings,
  GROUP_MIN,
  honestyLine,
  itemKey,
  kindTotals,
  rankGrouped,
  totalMembers,
  uniqueItemKeys,
} from "./grouping";

function finding(overrides: Partial<CodeFinding> = {}): CodeFinding {
  return {
    kind: "unused-variable",
    title: "Variable sin uso",
    detail: "",
    metric: { label: "usos", value: 0 },
    severity: 40,
    locations: [{ file: "LocalCache.java", startLine: 1, endLine: 1 }],
    ...overrides,
  };
}

describe("groupFindings", () => {
  it("no agrupa por debajo de GROUP_MIN — quedan sueltos", () => {
    const list = Array.from({ length: GROUP_MIN - 1 }, (_, i) => finding({ severity: i }));
    const items = groupFindings(list);
    expect(items.every((i) => i.type === "single")).toBe(true);
    expect(items).toHaveLength(GROUP_MIN - 1);
  });

  it("agrupa (file, kind) en una sola tarjeta al llegar a GROUP_MIN", () => {
    const list = Array.from({ length: GROUP_MIN }, (_, i) => finding({ severity: i }));
    const items = groupFindings(list);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("group");
  });

  it("colapsa un archivo con 261 hallazgos de un solo kind en UNA tarjeta, no 261", () => {
    const list = Array.from({ length: 261 }, (_, i) => finding({ severity: i % 100 }));
    expect(groupFindings(list)).toHaveLength(1);
  });

  it("un archivo con varios kinds queda en varias tarjetas, una por kind — nunca una sola por archivo", () => {
    const list = [
      ...Array.from({ length: 10 }, (_, i) => finding({ kind: "unused-variable", severity: i })),
      ...Array.from({ length: 8 }, (_, i) => finding({ kind: "long-function", severity: i })),
    ];
    const items = groupFindings(list);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.type === "group")).toBe(true);
  });

  it("distintos archivos no se mezclan en el mismo grupo", () => {
    const list = [
      ...Array.from({ length: GROUP_MIN }, () => finding({ locations: [{ file: "a.java", startLine: 1, endLine: 1 }] })),
      ...Array.from({ length: GROUP_MIN }, () => finding({ locations: [{ file: "b.java", startLine: 1, endLine: 1 }] })),
    ];
    expect(groupFindings(list)).toHaveLength(2);
  });

  it("el score de un grupo es el MÁXIMO de sus miembros, nunca la suma", () => {
    const list = Array.from({ length: GROUP_MIN }, (_, i) => finding({ severity: (i + 1) * 10 }));
    const items = groupFindings(list);
    const item = items[0];
    expect(item.type).toBe("group");
    if (item.type === "group") {
      expect(item.group.score).toBe(GROUP_MIN * 10);
      expect(item.group.memberCount).toBe(GROUP_MIN);
      expect(item.group.exemplars).toHaveLength(3);
    }
  });

  it("un hallazgo sin ubicación queda suelto, nunca rompe", () => {
    expect(() => groupFindings([finding({ locations: [] })])).not.toThrow();
    expect(groupFindings([finding({ locations: [] })])[0].type).toBe("single");
  });
});

describe("rankGrouped", () => {
  it("ordena grupos e ítems sueltos juntos, por score desc", () => {
    const highSingle = finding({ severity: 99, locations: [{ file: "x.java", startLine: 1, endLine: 1 }] });
    const groupMembers = Array.from({ length: GROUP_MIN }, () =>
      finding({ severity: 50, locations: [{ file: "a.java", startLine: 1, endLine: 1 }] }),
    );
    const items = rankGrouped([...groupMembers, highSingle]);
    expect(items[0].type).toBe("single");
  });

  it("es determinista: misma entrada, mismo orden", () => {
    const list = [finding({ severity: 10 }), finding({ severity: 90 }), finding({ severity: 50 })];
    expect(rankGrouped(list).map((i) => itemKey(i))).toEqual(rankGrouped(list).map((i) => itemKey(i)));
  });
});

describe("totalMembers", () => {
  it("cuenta los miembros reales detrás de una lista de ítems, no la cantidad de tarjetas", () => {
    const list = Array.from({ length: GROUP_MIN }, (_, i) => finding({ severity: i }));
    const items = groupFindings(list);
    expect(items).toHaveLength(1); // una tarjeta
    expect(totalMembers(items)).toBe(GROUP_MIN); // pero GROUP_MIN hallazgos reales
  });
});

describe("honestyLine", () => {
  it("usa la frase exacta con los totales reales", () => {
    expect(honestyLine(100, 11379, { groupsTotal: 2041, findingsTotal: 11379 })).toBe(
      "Mostrando 100 de 2041 grupos (11379 de 11379 hallazgos)",
    );
  });

  it("marca el recorte de almacenamiento cuando `truncated`", () => {
    const line = honestyLine(100, 5000, { groupsTotal: 2041, findingsTotal: 11379, truncated: true });
    expect(line).toContain("hay más de los que se guardaron");
  });

  it("nunca promete un total que no tiene, cuando faltan los campos", () => {
    const line = honestyLine(5, 12, {});
    expect(line).toContain("no disponible");
    expect(line).not.toMatch(/de \d+ grupos/);
  });
});

describe("kindTotals", () => {
  it("usa totalByKind cuando está — no es parcial", () => {
    const result = kindTotals([], { totalByKind: { "unused-variable": 1514 } });
    expect(result).toEqual({ counts: { "unused-variable": 1514 }, isPartial: false });
  });

  it("cae a contar lo mostrado y lo marca parcial cuando falta totalByKind", () => {
    const result = kindTotals([finding({ kind: "unused-variable" })], {});
    expect(result.isPartial).toBe(true);
    expect(result.counts["unused-variable"]).toBe(1);
  });
});

/**
 * OLA BB, FRENTE BB2 — la clave de LISTA. `itemKey` se repite en repos reales
 * (3 claves para 6 ítems en `corpus-app/Ghost`) y con claves repetidas el
 * `v-for` de Vue acumula tarjetas fantasma al filtrar: 3.910 al entrar,
 * 3.920 ocho cambios de filtro después.
 */
describe("uniqueItemKeys", () => {
  /** Dos hallazgos que `findingKey` NO puede separar: mismo kind, archivo, línea y título. */
  const gemelos = [
    finding({ kind: "complexity", title: "(anónima): complejidad cognitiva 18", severity: 60 }),
    finding({ kind: "complexity", title: "(anónima): complejidad cognitiva 18", severity: 50 }),
  ];

  it("dos ítems que comparten `itemKey` reciben claves DISTINTAS", () => {
    const items = rankGrouped(gemelos);
    expect(new Set(items.map(itemKey)).size).toBe(1); // la colisión existe de verdad
    const keys = uniqueItemKeys(items);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("la primera aparición conserva la clave original — sin sufijo de más", () => {
    const items = rankGrouped(gemelos);
    expect(uniqueItemKeys(items)[0]).toBe(itemKey(items[0]));
  });

  it("no hay ni una clave repetida sobre una lista larga con colisiones", () => {
    const items = rankGrouped([
      ...Array.from({ length: 7 }, () => finding({ kind: "complexity", title: "igual" })),
      finding({ kind: "long-function", title: "otra" }),
    ]);
    const keys = uniqueItemKeys(items);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("es PREFIJO-ESTABLE: la clave de una tarjeta no cambia cuando la lista crece por detrás (montaje escalonado)", () => {
    const items = rankGrouped([...gemelos, finding({ kind: "long-function", title: "z" })]);
    const completas = uniqueItemKeys(items);
    for (let corte = 1; corte <= items.length; corte++) {
      expect(uniqueItemKeys(items.slice(0, corte))).toEqual(completas.slice(0, corte));
    }
  });

  it("sin colisiones no cambia ninguna clave", () => {
    const items = rankGrouped([finding({ title: "a" }), finding({ title: "b" })]);
    expect(uniqueItemKeys(items)).toEqual(items.map(itemKey));
  });
});
