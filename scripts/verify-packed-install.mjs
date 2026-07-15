#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), "pi-hive-packed-install-"));
const project = join(sandbox, "project");
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
    "ui/review/dist/manifest.json",
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
  run(
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
      cwd: project,
      env: {
        PI_CODING_AGENT_DIR: piConfig,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
    },
  );

  console.log(
    `✓ installed ${installedPackage.name}@${installedPackage.version} from its packed tarball and loaded it in a clean, non-opted Pi environment`,
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
