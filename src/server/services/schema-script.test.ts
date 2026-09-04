/**
 * Extractor-output validation tests.
 *
 * These matter more than usual: the payload comes from a script an agent wrote,
 * so everything downstream depends on this layer refusing to pass through what
 * it cannot vouch for. The rule under test is "drop and warn, never trust".
 */
import { describe, expect, it } from "vitest";

import {
  SchemaScriptError,
  parseScriptOutput,
  stripFences,
  toGraph,
} from "./schema-script.js";

const VALID = {
  dialect: "prisma",
  entities: [
    {
      name: "users",
      sourceFile: "schema.prisma",
      sourceLine: 10,
      fields: [
        { name: "id", type: "Int", nullable: false, primaryKey: true },
        { name: "email", type: "String", nullable: false, default: "''" },
      ],
    },
    {
      name: "posts",
      sourceFile: "schema.prisma",
      sourceLine: 20,
      fields: [{ name: "author_id", type: "Int", nullable: true }],
    },
  ],
  relations: [
    {
      from: "posts",
      fromField: "author_id",
      to: "users",
      onDelete: "cascade",
      sourceFile: "schema.prisma",
      sourceLine: 25,
    },
  ],
};

describe("parseScriptOutput", () => {
  it("accepts the contract and preserves relation direction", () => {
    const out = parseScriptOutput(JSON.stringify(VALID));
    expect(out.dialect).toBe("prisma");
    expect(out.entities.map((e) => e.name)).toEqual(["users", "posts"]);
    expect(out.entities[0].fields[0]).toMatchObject({
      name: "id",
      type: "Int",
      nullable: false,
      primaryKey: true,
    });
    expect(out.entities[0].fields[1].default).toBe("''");
    expect(out.relations[0]).toMatchObject({
      from: "posts",
      fromField: "author_id",
      to: "users",
      onDelete: "cascade",
    });
    expect(out.warnings).toEqual([]);
  });

  it("tolerates a script that also logged around its JSON", () => {
    const noisy = `Detectando esquema...\n${JSON.stringify(VALID)}\nlisto`;
    expect(parseScriptOutput(noisy).entities).toHaveLength(2);
  });

  it("drops relations pointing at undeclared tables", () => {
    const out = parseScriptOutput(
      JSON.stringify({
        ...VALID,
        relations: [
          ...VALID.relations,
          { from: "posts", fromField: "ghost_id", to: "ghosts" },
        ],
      }),
    );
    // A phantom endpoint would render as a table that does not exist.
    expect(out.relations).toHaveLength(1);
    expect(out.warnings.join(" ")).toContain("ghosts");
  });

  it("drops malformed entities, fields and relations with a warning", () => {
    const out = parseScriptOutput(
      JSON.stringify({
        entities: [
          ...VALID.entities,
          { fields: [] },
          { name: "users", fields: [] },
          { name: "tags", fields: [{ type: "String" }, { name: "label" }] },
        ],
        relations: [...VALID.relations, { from: "posts" }, "nonsense"],
      }),
    );
    expect(out.entities.map((e) => e.name)).toEqual(["users", "posts", "tags"]);
    expect(out.entities[2].fields.map((f) => f.name)).toEqual(["label"]);
    expect(out.relations).toHaveLength(1);
    expect(out.warnings.length).toBeGreaterThanOrEqual(4);
  });

  it("defaults absent flags to the laxer reading", () => {
    const out = parseScriptOutput(
      JSON.stringify({ entities: [{ name: "t", fields: [{ name: "c" }] }] }),
    );
    const field = out.entities[0].fields[0];
    expect(field.nullable).toBe(true);
    expect(field.primaryKey).toBe(false);
    expect(field.pending).toBe(false);
    expect(field.type).toBe("");
  });

  it("rejects output that is not the contract at all", () => {
    expect(() => parseScriptOutput("")).toThrow(SchemaScriptError);
    expect(() => parseScriptOutput("hello")).toThrow(SchemaScriptError);
    // Valid JSON, but nothing usable in it.
    expect(() => parseScriptOutput('{"entities":[]}')).toThrow(/ninguna tabla/);
    expect(() => parseScriptOutput('{"tables":[]}')).toThrow(SchemaScriptError);
  });
});

describe("stripFences", () => {
  it("unwraps a fenced script and leaves a bare one alone", () => {
    const script = "#!/usr/bin/env bash\necho hi";
    expect(stripFences("```bash\n" + script + "\n```")).toBe(script + "\n");
    expect(stripFences("```\n" + script + "\n```")).toBe(script + "\n");
    expect(stripFences(script)).toBe(script + "\n");
    // A fence INSIDE the script (e.g. in a heredoc) must not be mangled.
    const withTicks = "#!/usr/bin/env bash\necho '```'";
    expect(stripFences(withTicks)).toBe(withTicks + "\n");
  });
});

describe("toGraph", () => {
  it("sorts entities and relations and collects the source files", () => {
    const graph = toGraph("backend", parseScriptOutput(JSON.stringify(VALID)));
    expect(graph.repoName).toBe("backend");
    expect(graph.entities.map((e) => e.name)).toEqual(["posts", "users"]);
    expect(graph.sourceFiles).toEqual(["schema.prisma"]);
  });
});
