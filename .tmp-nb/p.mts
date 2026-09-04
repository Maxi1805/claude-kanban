import { analyzeRepo } from "../src/server/services/code-analyzer.js";
const a: any = await analyzeRepo({ dir: process.argv[2], repoName: "x", limits: { maxFindings: "unlimited" } } as any);
const hs: any[] = [];
for (const f of a.findings ?? []) for (const h of (f as any).hypotheses ?? []) hs.push({ h, f });
console.log("hallazgos:", (a.findings ?? []).length, "| hipotesis:", hs.length);
const est = new Map<string, number>();
for (const { h } of hs) est.set(h.state ?? "?", (est.get(h.state ?? "?") ?? 0) + 1);
console.log("estados:", [...est].map(([k, n]) => `${k}=${n}`).join("  "));
// la prueba: algun check que solo el vecindario puede confirmar
let cruzada = 0, vistos = 0;
for (const { h } of hs) for (const c of [...(h.checks ?? []), ...(h.discriminators ?? [])]) {
  const id = c.id ?? c.label ?? "";
  if (/repetic|cruzad|vecind|neighbor/i.test(String(id))) { vistos++; if (c.passed || c.holds) cruzada++; }
}
console.log("checks de repeticion-cruzada vistos:", vistos, "| CONFIRMADOS:", cruzada);
