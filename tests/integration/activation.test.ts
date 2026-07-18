import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function throwingExtensionApi() {
  const fail = (name: string) => () => {
    throw new Error(`Unexpected registration in non-hive project: ${name}`);
  };
  return {
    registerTool: fail("registerTool"),
    registerCommand: fail("registerCommand"),
    registerShortcut: fail("registerShortcut"),
    on: fail("on"),
  };
}

test("extension factory performs zero registrations without hive-config.yaml", async () => {
  const previousCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-no-config-"));
  try {
    process.chdir(dir);
    const mod = await import(`../../index.ts?activation=${Date.now()}`);
    await mod.default(throwingExtensionApi());
    assert.ok(true);
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
