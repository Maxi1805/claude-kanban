/**
 * The hotspot map: a repo's files as packed circles, coloured by how bad they
 * are.
 *
 * A ranked list answers "what is worst" but makes you read every row to find
 * out WHERE the problems are, and it hides that ten of them sit in one folder.
 * Circle packing (the shape CodeScene uses for the same job) shows the whole
 * repo at once over the hierarchy you already know — your directories — so the
 * eye lands on the red without reading anything.
 *
 * Two encodings, deliberately separate:
 *   • SIZE  — lines of code. Healthy files are drawn too, because a red circle
 *             only reads as alarming next to the green ones around it.
 *   • COLOUR— the worst finding in that file. Severity, not count: one
 *             catastrophic function matters more than five long ones.
 *
 * Layout comes from d3-hierarchy, which ships with mermaid — no new dependency.
 *
 * CONTRATO-F7.md §2.5 — SIZE has a second dimension now: `axis` picks what
 * "big" means (lines, impact, or defect density), independent of COLOUR
 * (always worst severity). `"actividad"` (churn) is deliberately NOT a
 * member of {@link SizeAxis}: no `CodeFileSummary` in the payload carries
 * commit history (grepped — it doesn't exist anywhere in `shared/types.ts`
 * either), so there is nothing to size by. The caller (`HotspotMap.vue`)
 * shows a disabled 4th option instead of faking one with a proxy metric.
 */
import { hierarchy, pack, type HierarchyCircularNode } from "d3-hierarchy";

import type { CodeAnalysis, CodeFileSummary, CodeFinding } from "@/types";

/** How alarming a file is, in five steps so the palette stays readable. */
export type HealthTier = "clean" | "low" | "medium" | "high" | "critical";

/**
 * What a circle's AREA means. `"lineas"` is the default and the only one
 * that existed before this contract — every existing caller of `buildTree`
 * that omits the second argument gets byte-identical output.
 */
export type SizeAxis = "lineas" | "impacto" | "densidad";

/** A node in the packed tree: either a directory or a file. */
export interface MapNode {
  /** Repo-relative path; "" for the root. */
  path: string;
  /** Last path segment, for the label. */
  name: string;
  /** Directories have children; files do not. */
  children?: MapNode[];
  /** Lines of code — files only, rolled up for directories. Always the TRUE
   *  line count, regardless of `axis`: labels and tooltips should never lie
   *  about how much code is there just because the circle is sized by
   *  something else. */
  lines: number;
  /** What `layout()` actually sizes the circle by — `lines` under the
   *  default axis, `impacto`/`densidad`'s own units otherwise. Never zero
   *  (see `floor` in `buildTree`): a zero-weight leaf gets a zero-radius
   *  circle from `pack()` and disappears. */
  weight: number;
  /** Findings whose primary location is this file. */
  findings: CodeFinding[];
  /** Worst severity among `findings` (0 when clean). */
  worst: number;
  tier: HealthTier;
}

/** A laid-out circle, ready to render. */
export interface PackedCircle {
  node: MapNode;
  x: number;
  y: number;
  r: number;
  /** Tree depth, for styling directory rings. */
  depth: number;
  isFile: boolean;
}

/**
 * Severity → tier. The cuts match the panel's existing colour steps so the map
 * and the list agree on what "bad" looks like.
 */
export function tierFor(severity: number): HealthTier {
  if (severity <= 0) return "clean";
  if (severity < 40) return "low";
  if (severity < 60) return "medium";
  if (severity < 85) return "high";
  return "critical";
}

/**
 * §2.5's three formulas. `lines` reuses the old `Math.max(1, …)` floor
 * verbatim — same numbers as before this contract for the default axis.
 * `impacto`/`densidad` get their own small floor for the same reason (a
 * genuinely clean, zero-impact file must still be a visible, tiny dot, not
 * an invisible one — the map's whole point is showing the clean files too).
 */
function weightFor(axis: SizeAxis, lines: number, findings: CodeFinding[]): number {
  if (axis === "lineas") return Math.max(1, lines);
  if (axis === "impacto") {
    const impact = findings.reduce(
      (sum, f) => sum + (f.score ?? f.severity / 100) * (f.memberCount ?? 1),
      0,
    );
    return Math.max(0.02, impact);
  }
  // densidad — findings per 1.000 lines. `lines` is already floored to ≥ 1
  // by the caller, so this never divides by zero.
  const density = (findings.length / Math.max(1, lines)) * 1000;
  return Math.max(0.02, density);
}

/**
 * A finding is attributed to the file of its FIRST location: duplication spans
 * several files, and counting it against all of them would paint half the repo
 * red for a single problem. The other copies stay visible in the finding
 * itself, which is where they are actionable.
 *
 * Exported so anything else needing "what colours this file" (`EgoView.vue`'s
 * per-node tier, e.g.) uses the SAME attribution `buildTree` does, rather
 * than a second, silently-different rule.
 */
export function findingsByFile(analysis: CodeAnalysis): Map<string, CodeFinding[]> {
  const map = new Map<string, CodeFinding[]>();
  for (const finding of analysis.findings) {
    const file = finding.locations[0]?.file;
    if (!file) continue;
    const list = map.get(file);
    if (list) list.push(finding);
    else map.set(file, [finding]);
  }
  return map;
}

/**
 * Group an analysis into a directory tree.
 *
 * `axis` (default `"lineas"`) picks what `layout()` sizes circles BY — see
 * `SizeAxis`/`weightFor` above. Omitting it reproduces the exact output this
 * function always had.
 */
/**
 * A directory node before anything is hung off it — its totals are filled in
 * later by `rollUp`, so both the root and every intermediate dir start here.
 */
function emptyDirectory(path: string, name: string): MapNode {
  return { path, name, children: [], lines: 0, weight: 0, findings: [], worst: 0, tier: "clean" };
}

/** A file node: the only leaf, and the only place findings actually live. */
function fileLeaf(file: CodeFileSummary, findings: CodeFinding[], axis: SizeAxis): MapNode {
  const segments = file.path.split("/");
  const worst = findings.reduce((max, f) => Math.max(max, f.severity), 0);
  return {
    path: file.path,
    name: segments[segments.length - 1] ?? file.path,
    // A zero-line file would get a zero-radius circle and disappear, so every
    // file is worth at least one unit of area.
    lines: Math.max(1, file.lines),
    weight: weightFor(axis, file.lines, findings),
    findings: [...findings].sort((a, b) => b.severity - a.severity),
    worst,
    tier: tierFor(worst),
  };
}

export function buildTree(analysis: CodeAnalysis, axis: SizeAxis = "lineas"): MapNode {
  const perFile = findingsByFile(analysis);

  const root = emptyDirectory("", analysis.repoName);
  const directories = new Map<string, MapNode>([["", root]]);

  /** Get (or create) the directory node for a repo-relative dir path. */
  const directoryFor = (dirPath: string): MapNode => {
    const existing = directories.get(dirPath);
    if (existing) return existing;

    const segments = dirPath.split("/");
    const node = emptyDirectory(dirPath, segments[segments.length - 1] ?? dirPath);
    directoryFor(segments.slice(0, -1).join("/")).children!.push(node);
    directories.set(dirPath, node);
    return node;
  };

  for (const file of analysis.files) {
    const segments = file.path.split("/");
    directoryFor(segments.slice(0, -1).join("/")).children!.push(
      fileLeaf(file, perFile.get(file.path) ?? [], axis),
    );
  }

  collapseSingleChildDirectories(root);
  rollUp(root);
  return root;
}

/**
 * Collapse `a` → `b` → `c` chains into `a/b/c`. Rails and Nuxt trees are deep
 * and narrow, and a ring per level with nothing to compare inside it wastes the
 * radius that should be showing files.
 */
function collapseSingleChildDirectories(node: MapNode): void {
  if (!node.children) return;
  for (const child of node.children) collapseSingleChildDirectories(child);

  // Never collapse the root: its name is the repo.
  if (node.path === "") return;
  for (;;) {
    const children: MapNode[] = node.children;
    if (children.length !== 1) return;
    const only = children[0];
    if (!only.children) return;
    node.name = `${node.name}/${only.name}`;
    node.path = only.path;
    node.children = only.children;
  }
}

/** Propagate lines, weight and worst-severity up the tree. */
function rollUp(node: MapNode): void {
  if (!node.children) return;
  let lines = 0;
  let weight = 0;
  let worst = 0;
  for (const child of node.children) {
    rollUp(child);
    lines += child.lines;
    weight += child.weight;
    worst = Math.max(worst, child.worst);
  }
  node.lines = lines;
  node.weight = weight;
  node.worst = worst;
  node.tier = tierFor(worst);
}

/**
 * Lay the tree out as packed circles inside a square of `size` pixels.
 *
 * Area is proportional to `node.weight` — lines under the default axis, so a
 * file's visual size matches its actual weight in the repo; impact or defect
 * density under the other two (`buildTree`'s `axis` argument).
 */
export function layout(root: MapNode, size: number): PackedCircle[] {
  const packer = pack<MapNode>().size([size, size]).padding(3);
  const laid = packer(
    hierarchy(root, (node) => node.children).sum((node) =>
      node.children ? 0 : node.weight,
    ),
  );

  const circles: PackedCircle[] = [];
  laid.each((node: HierarchyCircularNode<MapNode>) => {
    circles.push({
      node: node.data,
      x: node.x,
      y: node.y,
      r: node.r,
      depth: node.depth,
      isFile: !node.data.children,
    });
  });
  return circles;
}

/** Files with at least one finding, worst first — the map's companion list. */
export function rankedFiles(root: MapNode): MapNode[] {
  const out: MapNode[] = [];
  const visit = (node: MapNode): void => {
    if (!node.children) {
      if (node.findings.length > 0) out.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out.sort((a, b) => b.worst - a.worst || b.findings.length - a.findings.length);
}
