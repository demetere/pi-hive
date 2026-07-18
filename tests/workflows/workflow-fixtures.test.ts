import assert from "node:assert/strict";
import fs, {
  type CopySyncOptions,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  copyWorkflowFixture,
  findNearestWorkflowProject,
  symlinkSupport,
  writeRepeatedFile,
} from "../helpers/workflow-fixtures.ts";

function workflowTempRoots(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("pi-hive-workflow-fixture-"))
    .sort();
}

function isStrictlyWithin(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

test("copyWorkflowFixture rejects unsafe fixture names without temp leaks", () => {
  const before = workflowTempRoots();
  for (const name of [
    "",
    "../artifact-free-debug",
    "invalid/../../artifact-free-debug",
    resolve("tests/fixtures/workflow-configs/artifact-free-debug"),
  ]) {
    assert.throws(() => copyWorkflowFixture(name), /fixture name/i, name);
  }
  assert.deepEqual(workflowTempRoots(), before);
});

test("copyWorkflowFixture rejects unsafe or missing project subdirectories without temp leaks", () => {
  const before = workflowTempRoots();
  for (const projectSubdir of [
    "../outside",
    "project/../../outside",
    resolve(tmpdir(), "absolute-project"),
    "missing-project",
  ]) {
    assert.throws(
      () => copyWorkflowFixture("artifact-free-debug", { projectSubdir }),
      /projectSubdir/i,
      projectSubdir,
    );
    assert.deepEqual(workflowTempRoots(), before);
  }
});

test("copyWorkflowFixture validates missing sources without allocating temp roots", () => {
  const before = workflowTempRoots();
  assert.throws(
    () => copyWorkflowFixture("missing-fixture"),
    /fixture source directory/i,
  );
  assert.deepEqual(workflowTempRoots(), before);
});

test("copyWorkflowFixture removes its allocated root when copying fails", (t) => {
  const before = workflowTempRoots();
  t.mock.method(fs, "cpSync", () => {
    throw new Error("forced fixture copy failure");
  });
  assert.throws(
    () => copyWorkflowFixture("artifact-free-debug"),
    /forced fixture copy failure/,
  );
  assert.deepEqual(workflowTempRoots(), before);
});

test("copyWorkflowFixture cleanup removes its root and is idempotent", () => {
  const fixture = copyWorkflowFixture("artifact-free-debug");
  assert.equal(existsSync(fixture.fixtureRoot), true);
  fixture.cleanup();
  assert.equal(existsSync(fixture.fixtureRoot), false);
  assert.doesNotThrow(fixture.cleanup);
  assert.equal(existsSync(fixture.fixtureRoot), false);
});

test("copyWorkflowFixture creates isolated disposable project copies", () => {
  const first = copyWorkflowFixture("artifact-free-debug");
  const second = copyWorkflowFixture("artifact-free-debug");
  try {
    assert.notEqual(first.fixtureRoot, second.fixtureRoot);
    assert.notEqual(first.projectRoot, second.projectRoot);

    const relativeManifest = ".pi/hive/hive-config.yaml";
    const sourceManifest = join(first.sourceRoot, relativeManifest);
    const firstManifest = join(first.projectRoot, relativeManifest);
    const secondManifest = join(second.projectRoot, relativeManifest);
    const sourceBefore = readFileSync(sourceManifest, "utf8");
    writeFileSync(firstManifest, "changed copy\n");

    assert.equal(readFileSync(sourceManifest, "utf8"), sourceBefore);
    assert.equal(readFileSync(secondManifest, "utf8"), sourceBefore);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("copied symlink fixture preserves a contained fixture-root escape", (t) => {
  const support = symlinkSupport();
  if (!support.supported) {
    t.skip(support.reason);
    return;
  }

  const fixture = copyWorkflowFixture("invalid/symlink-escape", {
    projectSubdir: "project",
  });
  try {
    const linkPath = join(fixture.projectRoot, ".pi/hive/agents/debugger.md");
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(linkPath), "../../../../outside-agent.md");
    const target = realpathSync(linkPath);
    assert.equal(isStrictlyWithin(fixture.projectRoot, target), false);
    assert.equal(isStrictlyWithin(fixture.fixtureRoot, target), true);
  } finally {
    fixture.cleanup();
  }
});

test("nested fixture selects only the nearest ancestor manifest", () => {
  const fixture = copyWorkflowFixture("nested-project");
  try {
    const child = findNearestWorkflowProject(
      join(fixture.projectRoot, "packages/child/work/deep"),
    );
    assert.deepEqual(child, {
      projectRoot: join(fixture.projectRoot, "packages/child"),
      manifestPath: join(
        fixture.projectRoot,
        "packages/child/.pi/hive/hive-config.yaml",
      ),
    });

    const parent = findNearestWorkflowProject(
      join(fixture.projectRoot, ".pi/hive/agents"),
    );
    assert.deepEqual(parent, {
      projectRoot: fixture.projectRoot,
      manifestPath: join(fixture.projectRoot, ".pi/hive/hive-config.yaml"),
    });
    assert.notEqual(child?.manifestPath, parent?.manifestPath);
  } finally {
    fixture.cleanup();
  }
});

function fixtureFiles(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(current, entry.name);
      if (entry.isDirectory()) return fixtureFiles(root, path);
      return [relative(root, path).split(sep).join("/")];
    })
    .sort();
}

const validFixtureFiles: Record<string, string[]> = {
  "combined-delivery": [
    ".pi/hive/agents/coder.md",
    ".pi/hive/agents/orchestrator.md",
    ".pi/hive/agents/planner.md",
    ".pi/hive/agents/tester.md",
    ".pi/hive/hive-config.yaml",
    ".pi/hive/knowledge/project-architecture/README.md",
    ".pi/hive/skills/orchestration/README.md",
    ".pi/hive/workflows/feature-delivery.yaml",
  ],
  "split-plan-build": [
    ".pi/hive/agents/coder.md",
    ".pi/hive/agents/coding-lead.md",
    ".pi/hive/agents/planner.md",
    ".pi/hive/agents/planning-lead.md",
    ".pi/hive/agents/tester.md",
    ".pi/hive/hive-config.yaml",
    ".pi/hive/knowledge/project-architecture/README.md",
    ".pi/hive/skills/orchestration/README.md",
    ".pi/hive/workflows/feature-build.yaml",
    ".pi/hive/workflows/feature-plan.yaml",
  ],
  "artifact-free-debug": [
    ".pi/hive/agents/debugger.md",
    ".pi/hive/hive-config.yaml",
    ".pi/hive/workflows/debug-chat.yaml",
  ],
  "nested-project": [
    ".pi/hive/agents/parent-root.md",
    ".pi/hive/hive-config.yaml",
    ".pi/hive/workflows/parent-chat.yaml",
    "packages/child/.pi/hive/agents/child-root.md",
    "packages/child/.pi/hive/hive-config.yaml",
    "packages/child/.pi/hive/workflows/child-chat.yaml",
    "packages/child/work/deep/.keep",
  ],
};

const standardInvalidFiles = [
  ".pi/hive/agents/debugger.md",
  ".pi/hive/hive-config.yaml",
  ".pi/hive/workflows/debug-chat.yaml",
];

const invalidFixtureFiles: Record<string, string[]> = {
  "bad-registry-id": standardInvalidFiles,
  "bad-team-node-id": standardInvalidFiles,
  "duplicate-key": standardInvalidFiles,
  "duplicate-team-node-id": standardInvalidFiles,
  "empty-prompt": standardInvalidFiles,
  "missing-agent-resource": [
    ".pi/hive/hive-config.yaml",
    ".pi/hive/workflows/debug-chat.yaml",
  ],
  "missing-checkpoint": standardInvalidFiles,
  "missing-workflow-resource": [
    ".pi/hive/agents/debugger.md",
    ".pi/hive/hive-config.yaml",
  ],
  "oversized-prompt-seed": [
    ...standardInvalidFiles,
    "generator-input.md",
  ].sort(),
  "symlink-escape": [
    "outside-agent.md",
    "project/.pi/hive/agents/debugger.md",
    "project/.pi/hive/hive-config.yaml",
    "project/.pi/hive/workflows/debug-chat.yaml",
  ],
  "unknown-agent-id": standardInvalidFiles,
  "unknown-agent-key": standardInvalidFiles,
  "unknown-checkpoint": standardInvalidFiles,
  "unknown-manifest-key": standardInvalidFiles,
  "unknown-suggested-next-id": standardInvalidFiles,
  "unknown-workflow-key": standardInvalidFiles,
  "unsupported-schema-version": standardInvalidFiles,
  "widening-filesystem-override": standardInvalidFiles,
};

const invalidFixtures = Object.keys(invalidFixtureFiles).sort();

function assertInvalidFixtureInventory(
  name: string,
  expectedFiles: string[],
  support: ReturnType<typeof symlinkSupport>,
): void {
  const fixture = copyWorkflowFixture(join("invalid", name));
  try {
    assert.deepEqual(fixtureFiles(fixture.fixtureRoot), expectedFiles, name);
    if (name === "symlink-escape") {
      if (support.supported) {
        assert.equal(
          lstatSync(
            join(
              fixture.fixtureRoot,
              "project",
              ".pi",
              "hive",
              "agents",
              "debugger.md",
            ),
          ).isSymbolicLink(),
          true,
        );
      } else {
        assert.match(support.reason, /\S/);
      }
    }
  } finally {
    fixture.cleanup();
  }
}

test("workflow configuration fixture inventory and filesystem contracts are frozen", () => {
  for (const [name, expectedFiles] of Object.entries(validFixtureFiles)) {
    const fixture = copyWorkflowFixture(name);
    try {
      assert.deepEqual(fixtureFiles(fixture.projectRoot), expectedFiles);
      const manifests = expectedFiles.filter((path) =>
        path.endsWith("hive-config.yaml"),
      );
      for (const manifest of manifests) {
        assert.match(
          readFileSync(join(fixture.projectRoot, manifest), "utf8"),
          /^schema-version: 1$/m,
        );
      }
      const workflowPaths = expectedFiles.filter((path) =>
        path.includes("/workflows/"),
      );
      assert.ok(
        workflowPaths.every((path) =>
          /^(.+\/)?\.pi\/hive\/workflows\/[^/]+\.yaml$/.test(path),
        ),
      );
    } finally {
      fixture.cleanup();
    }
  }

  const invalid = copyWorkflowFixture("invalid");
  try {
    assert.deepEqual(
      readdirSync(invalid.projectRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
      invalidFixtures,
    );
  } finally {
    invalid.cleanup();
  }

  const support = symlinkSupport();
  for (const [name, expectedFiles] of Object.entries(invalidFixtureFiles)) {
    assertInvalidFixtureInventory(name, expectedFiles, support);
  }
});

test("invalid inventory accepts a materialized symlink only when support is unavailable", (t) => {
  const copy = fs.cpSync.bind(fs);
  t.mock.method(
    fs,
    "cpSync",
    (source: string | URL, destination: string | URL, options?: CopySyncOptions) => {
      copy(source, destination, options);
      const materializedLink = join(
        destination.toString(),
        "project",
        ".pi",
        "hive",
        "agents",
        "debugger.md",
      );
      fs.rmSync(materializedLink);
      writeFileSync(materializedLink, "materialized symlink fixture\n");
    },
  );

  assert.doesNotThrow(() =>
    assertInvalidFixtureInventory(
      "symlink-escape",
      invalidFixtureFiles["symlink-escape"],
      { supported: false, reason: "simulated symlink-incapable checkout" },
    ),
  );
});

test("empty-prompt fixture has an empty body without whitespace-only lines", () => {
  const fixture = copyWorkflowFixture("invalid/empty-prompt");
  try {
    const agent = readFileSync(
      join(fixture.projectRoot, ".pi", "hive", "agents", "debugger.md"),
      "utf8",
    );
    const closingFrontmatter = agent.indexOf("\n---\n", 4);
    assert.notEqual(closingFrontmatter, -1);
    const body = agent.slice(closingFrontmatter + "\n---\n".length);
    assert.equal(body.trim(), "");
    assert.doesNotMatch(body, /^[\t ]+$/m);
  } finally {
    fixture.cleanup();
  }
});

test("workflow configuration YAML contains no legacy planning or hive team schema", () => {
  for (const name of [...Object.keys(validFixtureFiles), "invalid"]) {
    const fixture = copyWorkflowFixture(name);
    try {
      for (const path of fixtureFiles(fixture.fixtureRoot).filter((path) =>
        path.endsWith(".yaml"),
      )) {
        const yaml = readFileSync(join(fixture.fixtureRoot, path), "utf8");
        assert.doesNotMatch(yaml, /^(?:planning|hive):/m, `${name}/${path}`);
      }
    } finally {
      fixture.cleanup();
    }
  }
});

test("oversized prompt seed defers the byte limit but supports exact generation", () => {
  const fixture = copyWorkflowFixture("invalid/oversized-prompt-seed");
  try {
    const generated = join(fixture.fixtureRoot, "generated-prompt.seed");
    writeRepeatedFile(generated, 17, "z");
    assert.equal(statSync(generated).size, 17);
    assert.equal(readFileSync(generated, "utf8"), "z".repeat(17));
  } finally {
    fixture.cleanup();
  }
});
