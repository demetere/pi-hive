import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { MARKDOWN_PLAN_ARTIFACT_ADAPTER } from "../../src/artifacts/adapters/markdown-plan.ts";
import { NONE_ARTIFACT_ADAPTER } from "../../src/artifacts/adapters/none.ts";
import { OPEN_SPEC_ARTIFACT_ADAPTER } from "../../src/artifacts/adapters/openspec.ts";
import {
  assertArtifactActionFilesystemContained,
  assertArtifactAdapterContract,
  assertArtifactModuleBoundary,
} from "../helpers/artifact-adapter-contract.ts";

test("built-in implemented adapters pass the reusable lifecycle contract", () => {
  assertArtifactAdapterContract(NONE_ARTIFACT_ADAPTER);
  assertArtifactAdapterContract(MARKDOWN_PLAN_ARTIFACT_ADAPTER);
  assertArtifactAdapterContract(OPEN_SPEC_ARTIFACT_ADAPTER);
});

test("real action harness snapshots the fixture filesystem and catches undeclared outside writes and symlink escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-adapter-contract-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace); mkdirSync(outside);
  await assertArtifactActionFilesystemContained({ filesystemRoot: root, workspacePath: workspace, invoke: () => writeFileSync(join(workspace, "inside.txt"), "safe") });
  await assert.rejects(() => assertArtifactActionFilesystemContained({ filesystemRoot: root, workspacePath: workspace, invoke: () => writeFileSync(join(outside, "escaped.txt"), "unsafe") }), /outside its bound workspace/i);
  await assert.rejects(() => assertArtifactActionFilesystemContained({ filesystemRoot: root, workspacePath: workspace, invoke: () => symlinkSync(outside, join(workspace, "escaped-link")) }), /outside its bound workspace/i);
});

test("new generic runtime has no OpenSpec artifact-semantic branch or import", () => {
  for (const path of [
    "src/artifacts/facade.ts",
    "src/artifacts/workspaces.ts",
    "src/artifacts/operations.ts",
    "src/artifacts/approvals.ts",
    "src/workflows/prompts.ts",
    "src/workflows/tools.ts",
    "src/workflows/orchestration.ts",
  ]) {
    const source = readFileSync(resolve(path), "utf8");
    assert.doesNotMatch(source, /(?:openspec|proposal|specs(?:\/|\b))/iu, `${path} contains OpenSpec-specific runtime semantics`);
  }
});

test("artifact modules have no model, delegation, routing, Pi runtime, or workflow-orchestration boundary", () => {
  assertArtifactModuleBoundary([
    "src/artifacts/types.ts",
    "src/artifacts/contracts.ts",
    "src/artifacts/registry.ts",
    "src/artifacts/facade.ts",
    "src/artifacts/hashes.ts",
    "src/artifacts/leases.ts",
    "src/artifacts/operations.ts",
    "src/artifacts/workspaces.ts",
    "src/artifacts/internal/caller.ts",
    "src/artifacts/adapters/none.ts",
    "src/artifacts/adapters/markdown-plan.ts",
    "src/artifacts/adapters/openspec.ts",
  ].map((path) => resolve(path)));
});
