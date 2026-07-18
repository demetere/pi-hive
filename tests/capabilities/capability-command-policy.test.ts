import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeCommand, authorizeCommand, createCommandPolicyHook } from "../../src/capabilities/command.ts";
import { normalizeCapabilities } from "../../src/capabilities/policy.ts";

const all = normalizeCapabilities({ shell: ["inspect", "test", "build", "package", "mutate", "execute-code"], git: true, "external-network": true });

test("command classifier requires every applicable closed shell class", () => {
  const rows: Array<[string, string[]]> = [
    ["git status", ["inspect"]], ["npm test", ["test", "execute-code"]],
    ["npm run build", ["build", "execute-code"]], ["npm install", ["package", "execute-code"]],
    ["rm src/a.ts", ["mutate"]], ["node script.js", ["execute-code"]],
  ];
  for (const [command, classes] of rows) assert.deepEqual(analyzeCommand(command).classes, classes, command);
  const denied = authorizeCommand("npm test", normalizeCapabilities({ shell: ["test"] }));
  assert.equal(denied.ok, false); assert.match(denied.reason, /execute-code/);
  assert.equal(authorizeCommand("npm test", all).ok, true);
});

test("opaque interpreters, scripts, package hooks, aliases, and multi-command syntax fail closed", () => {
  for (const command of ["python -c 'open(\"x\",\"w\")'", "./script.sh", "sh script.sh", "npm run custom", "git alias.do '!rm x'"])
    assert.equal(analyzeCommand(command).classes.includes("execute-code"), true, command);
  for (const command of ["unknown-mutator x", "rm", "git -c alias.x='!rm x' x", "echo ok | mystery"])
    assert.equal(authorizeCommand(command, all).ok, false, command);
});

test("Git forms are conservative and require Git, network, mutate, and execute-code as applicable", () => {
  const rows = [
    ["git status", false, false], ["git commit -m x", true, true], ["git push origin main", true, true],
    ["git submodule update --init", true, true], ["git -c alias.x='!echo x' x", true, true],
  ] as const;
  for (const [command, mutating, opaque] of rows) { const a = analyzeCommand(command); assert.equal(a.git, true); assert.equal(a.mutating, mutating); if (opaque) assert.equal(a.classes.includes("execute-code"), true); }
  assert.equal(authorizeCommand("git status", normalizeCapabilities({ shell: ["inspect"] })).ok, false);
  assert.equal(authorizeCommand("git push origin main", normalizeCapabilities({ shell: ["mutate", "execute-code"], git: true })).ok, false);
  assert.equal(authorizeCommand("git push origin main", all).ok, true);
  assert.equal(analyzeCommand("git checkout other").valid, false, "worktree-wide effects remain ambiguous without an exact path set");
  assert.equal(analyzeCommand("git submodule update --init").valid, false);
});

test("direct or re-enabled Bash calls remain independently checked", async () => {
  const hook = createCommandPolicyHook(normalizeCapabilities({ shell: ["inspect"] }));
  assert.equal(await hook({ toolName: "bash", input: { command: "pwd" } }), undefined);
  assert.match((await hook({ toolName: "bash", input: { command: "node script.js" } }))?.reason ?? "", /execute-code/);
  assert.equal(await hook({ toolName: "read", input: { path: "x" } }), undefined);
});

test("known filesystem effects are explicit and pathless mutations fail closed", () => {
  assert.deepEqual(analyzeCommand("rm src/a.ts src/b.ts").effects, [{ operation: "delete", path: "src/a.ts" }, { operation: "delete", path: "src/b.ts" }]);
  assert.equal(analyzeCommand("find src -delete").effects[0]?.operation, "delete");
  assert.equal(authorizeCommand("rm", all).ok, false);
  assert.equal(analyzeCommand("cat secrets.env").acceptedRisks.includes("bare-filename-read"), true);
  assert.equal(analyzeCommand("node -e 'write()'").acceptedRisks.includes("interpreter-hidden-write"), true);
});
