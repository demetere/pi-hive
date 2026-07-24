import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("find classifies safe roots and local references while indirect and symlink-following forms fail closed", () => {
  assert.deepEqual(analyzeCommand("find -P src -name '*.md'").effects, [
    { operation: "read", path: "src", recursive: true },
  ]);
  assert.deepEqual(analyzeCommand("find src -samefile .git/config").effects, [
    { operation: "read", path: "src", recursive: true },
    { operation: "read", path: ".git/config" },
  ]);
  for (const command of [
    "find src -newer .git/config",
    "find src -anewer .git/config",
    "find src -cnewer .git/config",
    "find src -newerBa .git/config",
    "find src -neweraB .git/config",
    "find src -newerBt .git/config",
  ]) assert.deepEqual(analyzeCommand(command).effects.at(-1), { operation: "read", path: ".git/config" }, command);
  assert.equal(analyzeCommand("find src -newermt 2026-01-01").valid, true, "ordinary literal timestamp comparisons remain safe");
  for (const command of [
    "find -H src -name '*.md'",
    "find -L src -delete",
    "find src -follow -type f -print",
    "find src -samefile",
    "find -H custom/knowledge/shared -exec cat {} +",
    "find custom/knowledge/shared -execdir cat {} +",
    "find -files0-from custom/knowledge/shared/paths.txt",
    "find . -fprint custom/knowledge/shared/results.txt",
  ]) assert.equal(analyzeCommand(command).valid, false, command);
});

test("explicit bare recursive roots are preserved and omitted roots default to the project", () => {
  for (const command of ["rg import src", "grep -r import src", "ls -R src"]) {
    assert.deepEqual(analyzeCommand(command).effects, [{ operation: "read", path: "src", recursive: true }], command);
  }
  for (const command of ["rg import", "grep -r import", "ls -R"]) {
    assert.deepEqual(analyzeCommand(command).effects, [{ operation: "read", path: ".", recursive: true }], command);
  }
});

test("grep regexp options preserve every explicit file operand", () => {
  for (const command of [
    "grep -e W22-PROTECTED-MARKER custom/knowledge/shared/doc.md",
    "grep -eW22-PROTECTED-MARKER custom/knowledge/shared/doc.md",
    "grep --regexp W22-PROTECTED-MARKER custom/knowledge/shared/doc.md",
    "grep --regexp=W22-PROTECTED-MARKER custom/knowledge/shared/doc.md",
  ]) assert.deepEqual(analyzeCommand(command).effects, [
    { operation: "read", path: "custom/knowledge/shared/doc.md" },
  ], command);
  assert.deepEqual(analyzeCommand("grep -e first -e second one.md two.md").effects, [
    { operation: "read", path: "one.md" },
    { operation: "read", path: "two.md" },
  ]);
});

test("grep directory recursion modes classify attached and separate roots recursively", () => {
  for (const command of [
    "grep -d recurse marker .",
    "grep -drecurse marker .",
    "grep --directories recurse marker .",
    "grep --directories=recurse marker .",
  ]) assert.deepEqual(analyzeCommand(command).effects, [
    { operation: "read", path: ".", recursive: true },
  ], command);
  for (const command of [
    "grep -d",
    "grep --directories",
    "grep --directories=unknown marker .",
    "grep --recurs marker .",
    "grep --direc=recurse marker .",
    "grep --dereference-recurs marker .",
    "grep --unknown-option marker .",
  ]) assert.equal(analyzeCommand(command).valid, false, command);
});

test("Git content selectors, blob/diff modes, pathspecs, and local mutations fail closed", () => {
  for (const command of [
    "git show HEAD:custom/knowledge/shared/secret.md",
    "git show HEAD -- custom/knowledge/shared/secret.md",
    "git diff HEAD -- custom/knowledge/shared/secret.md",
    "git diff --no-index custom/knowledge/shared/a.md outside.md",
    "git log -- custom/knowledge/shared/secret.md",
    "git clean -fd custom/knowledge/shared",
    "git rm -r custom/knowledge/shared",
    "git mv custom/knowledge/shared outside/shared",
    "git status --pathspec-from-file=custom/knowledge/shared/paths.txt",
    "git log -p --all",
    "git log -u --all",
    "git log --patch --all",
    "git log --full-diff --all",
    "git log --binary --all",
    "git log --patch-with-stat --all",
    "git log --patch-with-raw --all",
    "git log -U3 --all",
    "git log --unified --all",
    "git log --unified=3 --all",
    "git log -m --all",
    "git log --dd --all",
    "git log --remerge-diff --all",
    "git log --diff-merges=first-parent --all",
    "git log --diff-merges=remerge --all",
    "git log --diff-merges first-parent --all",
    "git log --no-diff-merges --all",
    "git log --word-diff --all",
    "git log --color-words --all",
    "git log -c --all",
    "git log --cc --all",
    "git log -SW22-PICKAXE-PROTECTED-MARKER --all",
    "git log -S W22-PICKAXE-PROTECTED-MARKER --all",
    "git log -GW22-PICKAXE-PROTECTED-MARKER --all",
    "git log -G W22-PICKAXE-PROTECTED-MARKER --all",
    "git log --pickaxe-all --all",
    "git log --pickaxe-regex --all",
    `git log --find-object=${"a".repeat(40)} --all`,
    `git log --find-object ${"a".repeat(40)} --all`,
    "git status -v",
    "git status -vv",
    "git status --verbose",
  ]) assert.equal(analyzeCommand(command).valid, false, command);
  for (const command of [
    "git log --oneline --all",
    "git log --stat --all",
    "git log --no-patch --all",
    "git status --short",
    "git status --porcelain=v2",
  ]) assert.equal(analyzeCommand(command).valid, true, command);
});

test("Git executable-backed pickaxe modes cannot query protected unattached content", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-command-git-pickaxe-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  const protectedRoot = join(root, ".pi/hive/knowledge/private");
  mkdirSync(protectedRoot, { recursive: true });
  writeFileSync(join(protectedRoot, "secret.md"), "W22-PICKAXE-PROTECTED-MARKER\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "protected unattached knowledge"], { cwd: root });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const blob = execFileSync("git", ["rev-parse", "HEAD:.pi/hive/knowledge/private/secret.md"], { cwd: root, encoding: "utf8" }).trim();
  const probes = [
    { command: "git log -SW22-PICKAXE-PROTECTED-MARKER --all --format=%H", args: ["log", "-SW22-PICKAXE-PROTECTED-MARKER", "--all", "--format=%H"] },
    { command: "git log -S W22-PICKAXE-PROTECTED-MARKER --all --format=%H", args: ["log", "-S", "W22-PICKAXE-PROTECTED-MARKER", "--all", "--format=%H"] },
    { command: "git log -GW22-PICKAXE-PROTECTED-MARKER --all --format=%H", args: ["log", "-GW22-PICKAXE-PROTECTED-MARKER", "--all", "--format=%H"] },
    { command: "git log -G W22-PICKAXE-PROTECTED-MARKER --all --format=%H", args: ["log", "-G", "W22-PICKAXE-PROTECTED-MARKER", "--all", "--format=%H"] },
    { command: "git log --pickaxe-all -S W22-PICKAXE-PROTECTED-MARKER --all --format=%H", args: ["log", "--pickaxe-all", "-S", "W22-PICKAXE-PROTECTED-MARKER", "--all", "--format=%H"] },
    { command: "git log --pickaxe-regex -S W22-PICKAXE-PROTECTED-MARKER --all --format=%H", args: ["log", "--pickaxe-regex", "-S", "W22-PICKAXE-PROTECTED-MARKER", "--all", "--format=%H"] },
    { command: `git log --find-object=${blob} --all --format=%H`, args: ["log", `--find-object=${blob}`, "--all", "--format=%H"] },
    { command: `git log --find-object ${blob} --all --format=%H`, args: ["log", "--find-object", blob, "--all", "--format=%H"] },
  ];
  for (const probe of probes) {
    assert.equal(execFileSync("git", probe.args, { cwd: root, encoding: "utf8" }).trim(), commit, `Git executable must prove the content oracle: ${probe.command}`);
    assert.equal(analyzeCommand(probe.command).valid, false, probe.command);
    assert.equal(authorizeCommand(probe.command, all).ok, false, `${probe.command} must fail before execution`);
  }
});

test("recursive symlink-following inspect and mutation modes fail closed without denying no-follow forms", () => {
  for (const command of [
    "grep -R marker src",
    "grep --dereference-recursive marker src",
    "rg -L marker src",
    "rg -Li marker src",
    "rg --follow marker src",
    "cp -RH src copied",
    "cp -RL src copied",
    "cp -R --dereference src copied",
    "cp -R --deref src copied",
    "cp --recursive --dereference src copied",
    "cp --recurs src copied",
    "ls -RL src",
    "ls -R --dereference src",
    "ls -R --dereference-command-line src",
    "ls --recursive --dereference-command-line-symlink-to-dir src",
    "ls --recurs src",
    "find -H src -print",
    "find -L src -delete",
  ]) assert.equal(analyzeCommand(command).valid, false, command);
  for (const command of [
    "grep -r marker src",
    "rg marker src",
    "cp -R src copied",
    "cp --recursive src copied",
    "cp -a src copied",
    "ls -R src",
    "ls --recursive src",
    "find -P src -print",
    "find src -delete",
  ]) assert.equal(analyzeCommand(command).valid, true, command);
});

test("touch reference forms emit reads and retain only target mutations", () => {
  for (const command of [
    "touch -r .git/config probe-touch-output",
    "touch -r.git/config probe-touch-output",
    "touch --reference .git/config probe-touch-output",
    "touch --reference=.git/config probe-touch-output",
  ]) assert.deepEqual(analyzeCommand(command).effects, [
    { operation: "read", path: ".git/config" },
    { operation: "create", path: "probe-touch-output" },
  ], command);
  assert.deepEqual(analyzeCommand("touch -d '2026-01-01' probe-touch-output").effects, [
    { operation: "create", path: "probe-touch-output" },
  ]);
});

test("rm, wc, git status, and touch use exact closed option grammars", { skip: process.platform !== "linux" ? "GNU executable probes run on Linux" : false }, () => {
  const root = mkdtempSync(join(tmpdir(), "hive-command-closed-options-"));
  mkdirSync(join(root, "rm-abbreviated"));
  mkdirSync(join(root, "rm-exact"));
  mkdirSync(join(root, "rm-short"));
  writeFileSync(join(root, "counted.md"), "one two\n");
  writeFileSync(join(root, "paths"), "counted.md\0");
  writeFileSync(join(root, "reference"), "reference\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "staged.md"), "W22-GIT-STATUS-VERBOSE-PROTECTED\n");
  execFileSync("git", ["add", "staged.md"], { cwd: root });

  assert.doesNotThrow(() => execFileSync("rm", ["--recurs", "rm-abbreviated"], { cwd: root }));
  assert.equal(existsSync(join(root, "rm-abbreviated")), false, "GNU rm must prove --recurs is recursive");
  const wcAbbreviated = execFileSync("wc", ["--files0-f=paths"], { cwd: root, encoding: "utf8" });
  assert.match(wcAbbreviated, /counted\.md/u, "GNU wc must prove --files0-f reads its filename list");
  const gitAbbreviated = execFileSync("git", ["status", "--verb"], { cwd: root, encoding: "utf8" });
  assert.match(gitAbbreviated, /W22-GIT-STATUS-VERBOSE-PROTECTED/u, "Git must prove --verb emits staged patch content");
  assert.doesNotThrow(() => execFileSync("touch", ["--ref=reference", "touch-abbreviated"], { cwd: root }));
  assert.equal(lstatSync(join(root, "touch-abbreviated")).mtimeMs, lstatSync(join(root, "reference")).mtimeMs, "GNU touch must prove --ref copies reference metadata");

  for (const command of [
    "rm --recurs rm-abbreviated",
    "wc --files0-f=paths",
    "git status --verb",
    "touch --ref=reference touch-abbreviated",
    "rm --unknown rm-abbreviated",
    "wc --unknown counted.md",
    "git status --unknown",
    "touch --unknown touch-output",
  ]) {
    assert.equal(analyzeCommand(command).valid, false, command);
    assert.equal(authorizeCommand(command, all).ok, false, `${command} must fail before authorization`);
  }

  assert.doesNotThrow(() => execFileSync("rm", ["--recursive", "rm-exact"], { cwd: root }));
  assert.doesNotThrow(() => execFileSync("rm", ["-rf", "rm-short"], { cwd: root }));
  assert.match(execFileSync("wc", ["--lines", "counted.md"], { cwd: root, encoding: "utf8" }), /^1\s+counted\.md/u);
  assert.match(execFileSync("wc", ["-w", "counted.md"], { cwd: root, encoding: "utf8" }), /^2\s+counted\.md/u);
  assert.doesNotThrow(() => execFileSync("git", ["status", "--short"], { cwd: root, stdio: "ignore" }));
  assert.doesNotThrow(() => execFileSync("git", ["status", "-sb"], { cwd: root, stdio: "ignore" }));
  assert.doesNotThrow(() => execFileSync("touch", ["--reference=reference", "touch-exact"], { cwd: root }));
  assert.doesNotThrow(() => execFileSync("touch", ["-r", "reference", "touch-short"], { cwd: root }));
  for (const command of [
    "rm --recursive rm-exact",
    "rm -rf rm-short",
    "wc --lines counted.md",
    "wc -w counted.md",
    "git status --short",
    "git status -sb",
    "touch --reference=reference touch-exact",
    "touch -r reference touch-short",
  ]) assert.equal(analyzeCommand(command).valid, true, command);
});

test("indirect configs, dynamic shell paths, and unsupported client surfaces fail closed", () => {
  for (const command of [
    "grep -f custom/knowledge/shared/patterns.txt outside.md",
    "grep --exclude-from=custom/knowledge/shared/excludes.txt pattern outside.md",
    "rg --ignore-file custom/knowledge/shared/ignore pattern outside",
    "rg --pre custom/knowledge/shared/filter pattern outside",
    "wc --files0-from=custom/knowledge/shared/paths.txt",
    "sed -i --file=custom/knowledge/shared/script.sed outside.md",
    "less custom/knowledge/shared/doc.md",
    "ssh -F custom/knowledge/shared/ssh.conf example.com",
    "gh release upload v1 custom/knowledge/shared/doc.md",
    "cat $KNOWLEDGE_FILE",
    "cat \"$KNOWLEDGE_FILE\"",
    "pwd\ncat custom/knowledge/shared/doc.md",
  ]) assert.equal(analyzeCommand(command).valid, false, command);
});

test("GNU recursive and dereference aliases are executable-supported but fail policy closed", { skip: process.platform !== "linux" ? "GNU executable probes run on Linux" : false }, () => {
  const root = mkdtempSync(join(tmpdir(), "hive-command-aliases-"));
  const knowledge = join(root, ".pi/hive/knowledge/private");
  const workspace = join(root, "workspace/nested");
  mkdirSync(knowledge, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(knowledge, "secret.md"), "W22-PROTECTED-MARKER\n");
  symlinkSync(knowledge, join(workspace, "knowledge-link"));

  const probes: Array<{ command: string; executable: string; args: string[] }> = [
    { command: "grep --recurs W22-PROTECTED-MARKER .", executable: "grep", args: ["--recurs", "W22-PROTECTED-MARKER", "."] },
    { command: "grep --direc=recurse W22-PROTECTED-MARKER .", executable: "grep", args: ["--direc=recurse", "W22-PROTECTED-MARKER", "."] },
    { command: "grep --dereference-recurs W22-PROTECTED-MARKER workspace", executable: "grep", args: ["--dereference-recurs", "W22-PROTECTED-MARKER", "workspace"] },
    { command: "find workspace -follow -type f -print", executable: "find", args: ["workspace", "-follow", "-type", "f", "-print"] },
    { command: "cp -R --deref workspace copied", executable: "cp", args: ["-R", "--deref", "workspace", "copied"] },
    { command: "ls -RL workspace", executable: "ls", args: ["-RL", "workspace"] },
  ];
  for (const probe of probes) {
    assert.doesNotThrow(() => execFileSync(probe.executable, probe.args, { cwd: root, stdio: "ignore" }), `GNU executable rejected probe: ${probe.command}`);
    assert.equal(analyzeCommand(probe.command).valid, false, probe.command);
  }
});

test("rg hostname helpers fail policy closed in separate and attached forms", async (t) => {
  for (const command of [
    "rg --hostname-bin ./hostname-bin --hyperlink-format 'file://{host}{path}:{line}' --color=always W22-RG-HOSTNAME-MARKER workspace",
    "rg --hostname-bin=./hostname-bin --hyperlink-format 'file://{host}{path}:{line}' --color=always W22-RG-HOSTNAME-MARKER workspace",
  ]) assert.equal(analyzeCommand(command).valid, false, command);

  const ripgrepProbe = spawnSync("rg", ["--version"], { stdio: "ignore" });
  const ripgrepMissing = (ripgrepProbe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  await t.test("real ripgrep executes the hostname helper when installed", { skip: ripgrepMissing ? "ripgrep is not installed" : false }, () => {
    const root = mkdtempSync(join(tmpdir(), "hive-command-rg-hostname-"));
    const workspace = join(root, "workspace");
    const marker = join(root, "hostname-bin-ran");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "needle.txt"), "W22-RG-HOSTNAME-MARKER\n");
    writeFileSync(join(root, "hostname-bin"), `#!/bin/sh\nprintf hostname > '${marker}'\n`, { mode: 0o755 });

    assert.doesNotThrow(() => execFileSync("rg", [
      "--hostname-bin", "./hostname-bin", "--hyperlink-format", "file://{host}{path}:{line}", "--color=always",
      "W22-RG-HOSTNAME-MARKER", "workspace",
    ], { cwd: root, stdio: "ignore" }));
    assert.equal(readFileSync(marker, "utf8"), "hostname", "the regression must prove ripgrep launched the configured executable");
  });
});

test("sed permits proven inline substitutions and rejects hidden read, write, execute, and script effects", { skip: process.platform !== "linux" ? "GNU sed probes run on Linux" : false }, () => {
  const root = mkdtempSync(join(tmpdir(), "hive-command-sed-"));
  const editable = join(root, "editable.md");
  const secret = join(root, "secret.md");
  const readLeak = join(root, "read-leak.md");
  const written = join(root, "written.md");
  const executed = join(root, "executed");
  writeFileSync(editable, "original\n");
  writeFileSync(secret, "W22-SED-PROTECTED-MARKER\n");
  writeFileSync(readLeak, "original\n");

  execFileSync("sed", ["-i", "s/original/changed/g", editable]);
  assert.equal(readFileSync(editable, "utf8"), "changed\n", "ordinary project substitution remains executable-compatible");
  for (const command of [
    "sed -i s/original/changed/ README.md",
    "sed -i -e s/original/changed/g README.md",
  ]) {
    assert.equal(analyzeCommand(command).valid, true, command);
    assert.deepEqual(analyzeCommand(command).effects, [{ operation: "update", path: "README.md" }], command);
  }

  execFileSync("sed", ["-i", "-e", `1r ${secret}`, readLeak]);
  assert.match(readFileSync(readLeak, "utf8"), /W22-SED-PROTECTED-MARKER/u);
  execFileSync("sed", ["-i", "-e", `w ${written}`, editable]);
  assert.equal(existsSync(written), true, "GNU sed w must prove the hidden write surface");
  execFileSync("sed", ["-i", "-e", `e printf executed > '${executed}'`, editable]);
  assert.equal(readFileSync(executed, "utf8"), "executed", "GNU sed e must prove the hidden execution surface");

  for (const program of [
    `r ${secret}`,
    `R ${secret}`,
    `w ${written}`,
    `W ${written}`,
    `e printf executed > '${executed}'`,
    `s/original/changed/w ${written}`,
    "s/original/changed/e",
    "d",
  ]) assert.equal(analyzeCommand(`sed -i -e '${program}' README.md`).valid, false, program);
  for (const command of [
    "sed -i -f script.sed README.md",
    "sed -i --file=script.sed README.md",
    "sed -i.bak s/original/changed/ README.md",
  ]) assert.equal(analyzeCommand(command).valid, false, command);
});

test("empty quoted sed expressions cannot hide executable-visible operands", { skip: process.platform !== "linux" ? "GNU sed probes run on Linux" : false }, () => {
  const root = mkdtempSync(join(tmpdir(), "hive-command-sed-empty-expression-"));
  const secret = join(root, "knowledge-secret.md");
  const hiddenOperand = join(root, "s/original/changed/g");
  mkdirSync(join(root, "s/original/changed"), { recursive: true });
  writeFileSync(secret, "W22-EMPTY-SED-PROTECTED\n");
  writeFileSync(join(root, "outside.md"), "ordinary\n");
  symlinkSync(secret, hiddenOperand);

  execFileSync("sed", ["-i", "-e", "", "s/original/changed/g", "outside.md"], { cwd: root });
  assert.equal(lstatSync(hiddenOperand).isSymbolicLink(), false, "GNU sed must prove the post-expression token is an input operand");
  assert.equal(readFileSync(hiddenOperand, "utf8"), "W22-EMPTY-SED-PROTECTED\n");

  for (const command of [
    "sed -i -e '' s/original/changed/g outside.md",
    "sed -i --expression '' s/original/changed/g outside.md",
  ]) assert.equal(analyzeCommand(command).valid, false, command);
});

test("BSD sed no-backup syntax preserves one exact mutation operand", { skip: process.platform !== "darwin" ? "BSD sed probe runs on macOS" : false }, () => {
  const root = mkdtempSync(join(tmpdir(), "hive-command-bsd-sed-"));
  const editable = join(root, "editable.md");
  writeFileSync(editable, "original\n");
  const command = "sed -i '' -e s/original/changed/g editable.md";
  const analyzed = analyzeCommand(command);
  assert.equal(analyzed.valid, true);
  assert.deepEqual(analyzed.effects, [{ operation: "update", path: "editable.md" }]);
  execFileSync("sed", ["-i", "", "-e", "s/original/changed/g", "editable.md"], { cwd: root });
  assert.equal(readFileSync(editable, "utf8"), "changed\n");
});

test("network clients classify uploads and fail closed for local output, config, and unsupported forms", () => {
  assert.deepEqual(analyzeCommand("curl --upload-file custom/knowledge/shared/doc.md https://example.com").effects, [
    { operation: "read", path: "custom/knowledge/shared/doc.md" },
  ]);
  assert.deepEqual(analyzeCommand("wget -O - --post-file=custom/knowledge/shared/doc.md https://example.com").effects, [
    { operation: "read", path: "custom/knowledge/shared/doc.md" },
  ]);
  assert.deepEqual(analyzeCommand("curl --header @custom/knowledge/shared/headers.txt https://example.com").effects, [
    { operation: "read", path: "custom/knowledge/shared/headers.txt" },
  ]);
  assert.deepEqual(analyzeCommand("curl --data-urlencode name@custom/knowledge/shared/body.txt https://example.com").effects, [
    { operation: "read", path: "custom/knowledge/shared/body.txt" },
  ]);
  assert.equal(analyzeCommand("curl -fsS https://example.com/status").valid, true);
  assert.equal(analyzeCommand("wget -qO- https://example.com/status").valid, true);
  for (const command of [
    "curl -o custom/knowledge/shared/output.md https://example.com",
    "curl --config custom/knowledge/shared/curl.conf https://example.com",
    "curl --write-out @custom/knowledge/shared/format.txt https://example.com",
    "curl --location https://example.com/redirect",
    "curl -L https://example.com/redirect",
    "curl --location --proto-redir =file https://example.com/redirect",
    "curl --proto =file --url https://example.com",
    "curl --proto-redir =file https://example.com",
    "curl --resolve example.com:443:127.0.0.1 https://example.com",
    "curl --connect-to example.com:443:127.0.0.1:443 https://example.com",
    "curl --interface 127.0.0.1 https://example.com",
    "wget https://example.com/output.md",
    "wget --config=custom/knowledge/shared/wgetrc -O - https://example.com",
    "scp custom/knowledge/shared/doc.md user@example.com:/tmp/doc.md",
    "scp user@example.com:/tmp/doc.md custom/knowledge/shared/doc.md",
  ]) assert.equal(analyzeCommand(command).valid, false, command);
});

test("network authorization extracts only classified URL operands and --url values", () => {
  for (const command of [
    "curl -H 'Accept: application/json' https://example.com",
    "curl --header 'Accept: application/json' https://example.com",
    "curl --data 'a:b' https://example.com",
    "curl --data=a:b --url=https://example.com",
    "curl --url https://example.com",
    "curl --url=https://example.com",
    "wget -O - --header 'Accept: application/json' https://example.com",
  ]) {
    const analyzed = analyzeCommand(command);
    assert.equal(analyzed.valid, true, command);
    assert.deepEqual(analyzed.networkTargets, ["https://example.com"], command);
    assert.equal(authorizeCommand(command, all).ok, true, command);
  }
  assert.equal(analyzeCommand("curl --proto =https https://example.com").valid, true);
  assert.equal(analyzeCommand("curl --proto-redir =http,https https://example.com").valid, true);
});
