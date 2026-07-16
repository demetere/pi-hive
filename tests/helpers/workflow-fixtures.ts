import fs, {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const workflowFixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/workflow-v1",
);

export interface WorkflowFixtureCopy {
  fixtureRoot: string;
  projectRoot: string;
  sourceRoot: string;
  cleanup(): void;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function sourceDirectory(name: string): string {
  if (name.length === 0 || isAbsolute(name)) {
    throw new Error(`Invalid workflow fixture name: ${JSON.stringify(name)}`);
  }
  const sourceRoot = resolve(workflowFixtureRoot, name);
  if (!pathIsWithin(workflowFixtureRoot, sourceRoot)) {
    throw new Error(`Invalid workflow fixture name: ${JSON.stringify(name)}`);
  }
  try {
    if (!statSync(sourceRoot).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Workflow fixture source directory is missing: ${sourceRoot}`);
  }
  return sourceRoot;
}

export function copyWorkflowFixture(
  name: string,
  options: { projectSubdir?: string } = {},
): WorkflowFixtureCopy {
  const sourceRoot = sourceDirectory(name);
  const projectSubdir = options.projectSubdir;
  if (projectSubdir !== undefined && (projectSubdir.length === 0 || isAbsolute(projectSubdir))) {
    throw new Error(`Invalid projectSubdir: ${JSON.stringify(projectSubdir)}`);
  }

  const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-hive-workflow-fixture-"));
  try {
    fs.cpSync(sourceRoot, fixtureRoot, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  } catch (error) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }

  const projectRoot = projectSubdir
    ? resolve(fixtureRoot, projectSubdir)
    : fixtureRoot;
  try {
    if (
      projectSubdir &&
      (!pathIsWithin(fixtureRoot, projectRoot) ||
        !statSync(projectRoot).isDirectory())
    ) {
      throw new Error("not a contained directory");
    }
  } catch (error) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    throw new Error(`Invalid projectSubdir: ${JSON.stringify(projectSubdir)}`, {
      cause: error,
    });
  }

  return {
    fixtureRoot,
    projectRoot,
    sourceRoot,
    cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true }),
  };
}

export function findNearestWorkflowProject(
  startPath: string,
): { projectRoot: string; manifestPath: string } | undefined {
  let current = resolve(startPath);
  while (true) {
    const manifestPath = join(current, ".pi/hive/hive-config.yaml");
    if (existsSync(manifestPath)) return { projectRoot: current, manifestPath };
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export type SymlinkSupport =
  | { supported: true }
  | { supported: false; reason: string };

export function symlinkSupport(): SymlinkSupport {
  const probeRoot = mkdtempSync(join(tmpdir(), "pi-hive-symlink-probe-"));
  try {
    writeFileSync(join(probeRoot, "target"), "probe\n");
    symlinkSync("target", join(probeRoot, "link"));
    return { supported: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { supported: false, reason: `Symbolic links unavailable: ${detail}` };
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

export function writeRepeatedFile(
  path: string,
  byteCount: number,
  byte = "x",
): void {
  if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
    throw new RangeError("byteCount must be a non-negative safe integer");
  }
  if (Buffer.byteLength(byte) !== 1) {
    throw new RangeError("byte must encode to exactly one byte");
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, byte.repeat(byteCount));
}
