import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIG_LIMITS,
  CONFIG_REGISTRY_LIMITS,
  dependencyChains,
  renderConfigDiagnosticsHuman,
  renderConfigDiagnosticsJson,
  sourceRange,
  type ConfigDiagnostic,
} from "../src/config/index.ts";

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function diagnostic(source: string, code: ConfigDiagnostic["code"] = "RESOURCE_NOT_FOUND"): ConfigDiagnostic {
  return {
    code,
    severity: "error",
    message: "missing resource",
    source,
    range: sourceRange(0, 1, 1, 1, 1, 2),
  };
}

test("iterative dependency chains are deterministic, cycle-safe, and bounded", () => {
  const graph = new Map<string, readonly string[]>([
    ["workflow:b", ["agent:z", "agent:a"]],
    ["agent:a", ["skill:x"]],
    ["skill:x", ["agent:a"]],
    ["agent:z", []],
  ]);
  const result = dependencyChains(graph, "workflow:b");
  assert.deepEqual(result.value, [
    ["workflow:b", "agent:a", "skill:x", "agent:a"],
    ["workflow:b", "agent:z"],
  ]);
  assert.equal(result.diagnostics.some(({ code }) => code === "DEPENDENCY_CYCLE"), true);

  const tooMany = new Map<string, readonly string[]>();
  for (let i = 0; i <= CONFIG_REGISTRY_LIMITS.dependencyNodes; i++) tooMany.set(`n${i}`, []);
  assert.equal(dependencyChains(tooMany, "n0").diagnostics[0]?.code, "DEPENDENCY_LIMIT_EXCEEDED");

  const tooManyEdges = new Map<string, readonly string[]>([[
    "root",
    Array.from({ length: CONFIG_REGISTRY_LIMITS.dependencyEdges + 1 }, (_, index) => `leaf-${index}`),
  ]]);
  assert.equal(dependencyChains(tooManyEdges, "root").diagnostics[0]?.code, "DEPENDENCY_LIMIT_EXCEEDED");

  const deep = new Map<string, readonly string[]>();
  for (let i = 0; i < 20; i++) deep.set(`deep-${i}`, i === 19 ? [] : [`deep-${i + 1}`]);
  const bounded = dependencyChains(deep, "deep-0");
  assert.equal(bounded.value?.[0]?.length, 16);
  assert.equal(bounded.diagnostics.some(({ code }) => code === "DEPENDENCY_LIMIT_EXCEEDED"), true);

  const nodesAtLimit = new Map<string, readonly string[]>([[
    "root",
    Array.from({ length: CONFIG_REGISTRY_LIMITS.dependencyNodes - 1 }, (_, index) => `referenced-${index}`),
  ]]);
  assert.equal(dependencyChains(nodesAtLimit, "root").diagnostics.some(({ code }) => code === "DEPENDENCY_LIMIT_EXCEEDED"), false);
  const nodesOverLimit = new Map<string, readonly string[]>([[
    "root",
    Array.from({ length: CONFIG_REGISTRY_LIMITS.dependencyNodes }, (_, index) => `referenced-${index}`),
  ]]);
  assert.equal(dependencyChains(nodesOverLimit, "root").diagnostics[0]?.code, "DEPENDENCY_LIMIT_EXCEEDED");

  const repeatedTarget = Array.from({ length: CONFIG_REGISTRY_LIMITS.dependencyEdges }, () => "leaf");
  assert.equal(dependencyChains(new Map([["root", repeatedTarget], ["leaf", []]]), "root").diagnostics.some(({ code }) => code === "DEPENDENCY_LIMIT_EXCEEDED"), false);
  assert.equal(dependencyChains(new Map([["root", [...repeatedTarget, "leaf"]], ["leaf", []]]), "root").diagnostics[0]?.code, "DEPENDENCY_LIMIT_EXCEEDED");
});

test("dependency diagnostics preserve supplied edge source metadata", () => {
  const range = sourceRange(20, 3, 5, 28, 3, 13);
  const graph = new Map([
    ["workflow:build", [{ target: "agent:coder", source: ".pi/hive/workflows/build.yaml", range }]],
    ["agent:coder", [{ target: "workflow:build", source: ".pi/hive/agents/coder.md", range }]],
  ]);
  const result = dependencyChains(graph, "workflow:build");
  const cycle = result.diagnostics.find(({ code }) => code === "DEPENDENCY_CYCLE");
  assert.equal(cycle?.source, ".pi/hive/agents/coder.md");
  assert.deepEqual(cycle?.range, range);

  const limitRange = sourceRange(40, 5, 2, 48, 5, 10);
  const edges = Array.from({ length: CONFIG_REGISTRY_LIMITS.dependencyNodes }, (_, index) =>
    index === CONFIG_REGISTRY_LIMITS.dependencyNodes - 1
      ? { target: `node-${index}`, source: ".pi/hive/workflows/limit.yaml", range: limitRange }
      : { target: `node-${index}` });
  const limited = dependencyChains(new Map([["root", edges]]), "root");
  assert.equal(limited.diagnostics[0]?.source, ".pi/hive/workflows/limit.yaml");
  assert.deepEqual(limited.diagnostics[0]?.range, limitRange);

  const workRange = sourceRange(60, 7, 3, 68, 7, 11);
  const duplicate = (target: string, count: number, metadata = false) => Array.from(
    { length: count },
    () => metadata ? { target, source: ".pi/hive/workflows/diamond.yaml", range: workRange } : { target },
  );
  const workLimited = dependencyChains(new Map([
    ["root", duplicate("a", 30)],
    ["a", duplicate("b", 30)],
    ["b", duplicate("leaf", 30, true)],
    ["leaf", []],
  ]), "root");
  const workDiagnostic = workLimited.diagnostics.find(({ code }) => code === "DEPENDENCY_LIMIT_EXCEEDED");
  assert.equal(workDiagnostic?.source, ".pi/hive/workflows/diamond.yaml");
  assert.deepEqual(workDiagnostic?.range, workRange);
});

test("dependency and diagnostic ordering does not depend on localeCompare", () => {
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = function forbiddenLocaleCompare(): never {
    throw new Error("localeCompare must not be used");
  };
  try {
    assert.doesNotThrow(() => dependencyChains(new Map([["root", ["z", "a"]], ["a", []], ["z", []]]), "root"));
    assert.doesNotThrow(() => renderConfigDiagnosticsJson([diagnostic("z"), diagnostic("a")], false));
  } finally {
    String.prototype.localeCompare = original;
  }
});

test("human and JSON diagnostic reports share deterministic ordering and redact unsafe sources", () => {
  const hostile = diagnostic("C:\\secret-drive\\private.yaml");
  hostile.message = "\u001b[31mCSI\u001b[0m \u001b]0;OSC-secret\u0007 \u001bPDCS-secret\u001b\\ \u009dC1-OSC-secret\u009c /posix/secret C:\\drive\\secret C:relative-secret \\\\server\\share\\unc-secret \\private\\rooted-secret workflow:build agent:coder\nnext\u0000line";
  const escIntermediate = diagnostic(".pi/hive/escape.yaml");
  escIntermediate.message = "left\u001b(0right";
  hostile.related = [{
    message: "\u001b]8;;https://secret.example\u0007link\u001b]8;;\u0007",
    source: "\\\\server\\share\\related-secret.yaml",
    range: hostile.range,
  }];
  const values = [
    hostile,
    diagnostic("/secret/root/.pi/hive/x.yaml"),
    diagnostic("C:drive-relative\\secret.yaml"),
    diagnostic(".pi/hive/a.yaml", "CONFIG_PATH_INVALID"),
    escIntermediate,
  ];
  const json = renderConfigDiagnosticsJson(values, false);
  assert.equal(json.formatVersion, 1);
  assert.equal(json.diagnostics[0]?.code, "CONFIG_PATH_INVALID");
  const serialized = JSON.stringify(json);
  for (const secret of ["secret-drive", "OSC-secret", "DCS-secret", "C1-OSC-secret", "posix", "drive", "relative-secret", "server", "share", "unc-secret", "rooted-secret", "secret.example"])
    assert.equal(serialized.includes(secret), false, secret);
  assert.equal(hasControl(json.diagnostics.map(({ message, source }) => `${message}${source}`).join("")), false);
  assert.equal(serialized.includes("workflow:build"), true);
  assert.equal(serialized.includes("agent:coder"), true);
  assert.equal(json.diagnostics.find(({ source }) => source === ".pi/hive/escape.yaml")?.message, "left right");
  const human = renderConfigDiagnosticsHuman(values, false);
  assert.equal(human.includes("/secret/root"), false);
  assert.equal(human.includes("workflow:build"), true);
  assert.equal(human.includes("agent:coder"), true);
  assert.equal(hasControl(human.replaceAll("\n", "")), false);
  assert.ok(Buffer.byteLength(JSON.stringify(json), "utf8") <= CONFIG_REGISTRY_LIMITS.renderedDiagnosticsBytes);
});

test("redaction consumes bounded absolute paths containing spaces without consuming prose", () => {
  const value = diagnostic(".pi/hive/redaction.yaml");
  value.message = "Inspect '/alpha SPACEPOSIX/LEAKPOSIX.txt'; then \"C:\\alpha SPACEDRIVE\\LEAKDRIVE.txt\"; and \\\\server\\alpha SPACEUNC\\LEAKUNC.txt, plus /unquoted SPACEUNQUOTED/LEAKUNQUOTED.txt before ordinary prose workflow:build agent:coder.";
  const report = renderConfigDiagnosticsJson([value], false);
  const message = report.diagnostics[0]!.message;
  for (const secret of ["SPACEPOSIX", "LEAKPOSIX", "SPACEDRIVE", "LEAKDRIVE", "SPACEUNC", "LEAKUNC", "SPACEUNQUOTED", "LEAKUNQUOTED"])
    assert.equal(message.includes(secret), false, secret);
  for (const prose of ["Inspect", "then", "and", "plus", "before ordinary prose", "workflow:build", "agent:coder"])
    assert.equal(message.includes(prose), true, prose);
});

test("redaction consumes unquoted extensionless absolute paths through delimiters or message end", () => {
  const value = diagnostic(".pi/hive/redaction-extensionless.yaml");
  value.message = "IDs workflow:build agent:coder; POSIX /alpha SPACEPOSIX/LEAKPOSIX; DRIVE C:\\alpha SPACEDRIVE\\LEAKDRIVE, UNC \\\\server\\alpha SPACEUNC\\LEAKUNC";
  const message = renderConfigDiagnosticsJson([value], false).diagnostics[0]!.message;
  for (const secret of ["alpha", "SPACEPOSIX", "LEAKPOSIX", "SPACEDRIVE", "LEAKDRIVE", "server", "SPACEUNC", "LEAKUNC"])
    assert.equal(message.includes(secret), false, secret);
  for (const prose of ["workflow:build", "agent:coder", "POSIX", "DRIVE", "UNC"])
    assert.equal(message.includes(prose), true, prose);
});

test("renderer caps candidates before reading identical sort prefixes", () => {
  const messageReads = new Set<number>();
  const values = Array.from({ length: 10_000 }, (_, index) => {
    const value = diagnostic(".pi/hive/same.yaml");
    Object.defineProperty(value, "message", {
      enumerable: true,
      get() {
        messageReads.add(index);
        return String(index).padStart(5, "0");
      },
    });
    return value;
  }).reverse();
  const report = renderConfigDiagnosticsJson(values, false);
  assert.equal(report.truncated, true);
  assert.equal(report.diagnostics.length, CONFIG_LIMITS.diagnostics);
  assert.ok(messageReads.size <= CONFIG_LIMITS.diagnostics);
  assert.equal(report.diagnostics[0]?.message, "09900");
});

test("bounded diagnostic ordering is total and reverse-input invariant", () => {
  const first = {
    ...diagnostic(".pi/hive/same.yaml"),
    severity: "warning" as const,
    range: sourceRange(0, 1, 1, 2, 1, 3),
    dependencyChain: ["workflow:build", "agent:coder"],
  };
  const second = {
    ...diagnostic(".pi/hive/same.yaml"),
    severity: "error" as const,
    range: sourceRange(0, 1, 1, 3, 1, 4),
    related: [{ message: "related", source: ".pi/hive/related.yaml", range: sourceRange(1, 1, 2, 2, 1, 3) }],
  };
  const forward = renderConfigDiagnosticsJson([first, second], false);
  const reverse = renderConfigDiagnosticsJson([second, first], false);
  assert.deepEqual(forward, reverse);
});

test("human rendering preserves bounded namespaced dependency chains", () => {
  const value = { ...diagnostic(".pi/hive/workflows/build.yaml"), dependencyChain: ["workflow:build", "agent:coder"] };
  const json = renderConfigDiagnosticsJson([value], false);
  assert.deepEqual(json.diagnostics[0]?.dependencyChain, ["workflow:build", "agent:coder"]);
  const human = renderConfigDiagnosticsHuman([value], false);
  assert.match(human, /workflow:build -> agent:coder/u);
});

test("JSON aggregate measurement reserves the worst final envelope", () => {
  const payloadCapacity = (1 + CONFIG_LIMITS.related * 2) * CONFIG_LIMITS.messageBytes;
  const make = (payloadBytes: number): ConfigDiagnostic => {
    let remaining = payloadBytes;
    const take = (): string => {
      const size = Math.min(remaining, CONFIG_LIMITS.messageBytes);
      remaining -= size;
      return "x".repeat(size);
    };
    return {
      ...diagnostic(".pi/hive/large.yaml"),
      message: take(),
      related: Array.from({ length: CONFIG_LIMITS.related }, () => ({
        message: take(),
        source: take(),
        range: sourceRange(0, 1, 1, 1, 1, 2),
      })),
    };
  };
  const values: ConfigDiagnostic[] = [];
  while (true) {
    const candidate = [...values, make(payloadCapacity)];
    const bytes = Buffer.byteLength(JSON.stringify({ formatVersion: 1, truncated: false, diagnostics: candidate }), "utf8");
    if (bytes > CONFIG_REGISTRY_LIMITS.renderedDiagnosticsBytes) break;
    values.push(make(payloadCapacity));
  }
  const withEmpty = [...values, make(0)];
  const base = Buffer.byteLength(JSON.stringify({ formatVersion: 1, truncated: false, diagnostics: withEmpty }), "utf8");
  const gap = CONFIG_REGISTRY_LIMITS.renderedDiagnosticsBytes + 1 - base;
  assert.ok(gap > 0 && gap <= payloadCapacity);
  values.push(make(gap));
  assert.equal(Buffer.byteLength(JSON.stringify({ formatVersion: 1, truncated: false, diagnostics: values }), "utf8"), CONFIG_REGISTRY_LIMITS.renderedDiagnosticsBytes + 1);
  const report = renderConfigDiagnosticsJson(values, false);
  assert.ok(Buffer.byteLength(JSON.stringify(report), "utf8") <= CONFIG_REGISTRY_LIMITS.renderedDiagnosticsBytes);
});

test("diagnostic report aggregate bound truncates whole entries", () => {
  const values = Array.from({ length: 200 }, (_, index) => ({
    ...diagnostic(`.pi/hive/${index}.yaml`),
    message: "x".repeat(4_000),
  }));
  const report = renderConfigDiagnosticsJson(values, false);
  assert.equal(report.truncated, true);
  assert.ok(report.diagnostics.length < values.length);
  assert.ok(report.diagnostics.length <= CONFIG_LIMITS.diagnostics);
  assert.ok(Buffer.byteLength(JSON.stringify(report), "utf8") <= CONFIG_REGISTRY_LIMITS.renderedDiagnosticsBytes);
});
