#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), "pi-hive-packed-install-"));
const project = join(sandbox, "unconfigured-project");
const configuredProject = join(sandbox, "configured-project");
const piConfig = join(sandbox, "pi-agent");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      ...options.env,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${result.status === null ? "" : ` with exit ${result.status}`}\n${details}`,
      { cause: result.error },
    );
  }
  return result.stdout;
}

try {
  writeFileSync(
    join(sandbox, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );

  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", sandbox]),
  );
  const tarballName = packed[0]?.filename;
  if (typeof tarballName !== "string" || tarballName !== basename(tarballName)) {
    throw new Error("npm pack did not return a safe tarball filename");
  }
  const tarball = resolve(sandbox, tarballName);
  if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarballName}`);

  const npmRoot = run("npm", ["root", "--global"]).trim();
  const { checkPlatform } = createRequire(import.meta.url)(join(npmRoot, "npm", "node_modules", "npm-install-checks"));
  const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  checkPlatform(packageManifest, false, { os: "linux", cpu: process.arch });
  let unsupportedCode;
  try { checkPlatform(packageManifest, false, { os: "win32", cpu: "x64" }); }
  catch (error) { unsupportedCode = error?.code; }
  if (unsupportedCode !== "EBADPLATFORM") throw new Error("npm's platform checker did not reject the package for Windows");

  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: sandbox,
  });

  const installedRoot = join(sandbox, "node_modules", "pi-hive");
  const installedPackage = JSON.parse(
    readFileSync(join(installedRoot, "package.json"), "utf8"),
  );
  if (installedPackage.pi?.extensions?.[0] !== "./index.ts") {
    throw new Error("installed package does not expose index.ts as its Pi extension");
  }
  for (const relativePath of [
    "index.ts",
    "ui/web/dist/index.html",
    "schemas/hive-manifest-v1.schema.json",
    "examples/artifact-free-debug/.pi/hive/hive-config.yaml",
    "examples/combined-openspec-delivery/openspec/config.yaml",
    "examples/combined-openspec-delivery/openspec/changes/.gitkeep",
    "examples/split-openspec-handoff/openspec/config.yaml",
    "examples/split-openspec-handoff/openspec/changes/.gitkeep",
  ]) {
    if (!existsSync(join(installedRoot, relativePath))) {
      throw new Error(`installed package is missing ${relativePath}`);
    }
  }

  mkdirSync(project);
  writeFileSync(
    join(project, ".keep"),
    "No .pi/hive/hive-config.yaml: the installed extension must remain inert.\n",
    { flag: "wx" },
  );

  const piCli = join(sandbox, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const loadInstalledExtension = (cwd) => run(
    process.execPath,
    [
      piCli,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--extension",
      installedRoot,
      "--list-models",
    ],
    {
      cwd,
      env: {
        PI_CODING_AGENT_DIR: piConfig,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
    },
  );
  loadInstalledExtension(project);
  if (readdirSync(project).join(",") !== ".keep") throw new Error("unconfigured packed load mutated the project");

  mkdirSync(configuredProject);
  cpSync(join(installedRoot, "examples", "artifact-free-debug", ".pi"), join(configuredProject, ".pi"), { recursive: true });
  loadInstalledExtension(configuredProject);

  console.log(
    `✓ verified npm rejects Windows, installed ${installedPackage.name}@${installedPackage.version} on Linux, and loaded it in inert unconfigured and schema-v1 configured projects`,
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
