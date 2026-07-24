import assert from "node:assert/strict";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { descriptorPath, linkAt, mkdirAt, openDescriptorAt, openDirectoryAt, readDirectoryAt, renameAt, statAt, unlinkAt } from "../../src/core/descriptor-fs.ts";

test("descriptor filesystem preserves relative identity across supported platforms", () => {
  const rootPath = mkdtempSync(join(tmpdir(), "pi-hive-descriptor-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-hive-descriptor-outside-"));
  const root = openSync(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let child: number | undefined;
  try {
    mkdirAt(root, "child", 0o700);
    child = openDirectoryAt(root, "child");
    assert.equal(descriptorPath(child), realpathSync.native(join(rootPath, "child")));
    const file = openDescriptorAt(child, "value.md", constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(file, "anchored\n"); closeSync(file);
    assert.equal(statAt(child, "value.md").kind, "file");
    assert.deepEqual([...readDirectoryAt(child)].sort(), ["value.md"]);
    linkAt(child, "value.md", child, "linked.md");
    renameAt(child, "linked.md", child, "published.md");
    const published = openDescriptorAt(child, "published.md", constants.O_RDONLY | constants.O_NOFOLLOW);
    try { assert.equal(readFileSync(published, "utf8"), "anchored\n"); }
    finally { closeSync(published); }

    symlinkSync(outside, join(rootPath, "link"), "dir");
    assert.equal(statAt(root, "link").kind, "symlink");
    assert.throws(() => openDirectoryAt(root, "link"), (error: unknown) => ["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""));

    const displaced = join(rootPath, "child-displaced");
    renameSync(join(rootPath, "child"), displaced);
    symlinkSync(outside, join(rootPath, "child"), "dir");
    const staged = openDescriptorAt(child, "staged.tmp", constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(staged, "safe\n"); closeSync(staged);
    renameAt(child, "staged.tmp", child, "safe.md");
    assert.equal(existsSync(join(outside, "safe.md")), false);
    assert.equal(readFileSync(join(displaced, "safe.md"), "utf8"), "safe\n");
    unlinkAt(child, "safe.md");
  } finally {
    if (child !== undefined) closeSync(child);
    closeSync(root);
    rmSync(rootPath, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
