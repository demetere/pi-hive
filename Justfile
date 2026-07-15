# pi-hive command runner
#
# Run `just` or `just --list --unsorted` to see every command.
# Run `just --choose` for interactive command selection.
#
# This file is the source of truth for local development, verification,
# packaging, and Pi extension reload workflows. Project docs should point here
# instead of spelling out lower-level package-manager commands.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
set dotenv-load := false
set export := true

# Paths
extension_dir := env_var_or_default("PI_HIVE_EXTENSION_DIR", env_var("HOME") + "/.pi/agent/extensions/pi-hive")
dashboard_dir := "ui/web"

# Telemetry defaults
telemetry_host := env_var_or_default("HIVE_TELEMETRY_HOST", "127.0.0.1")
telemetry_port := env_var_or_default("HIVE_TELEMETRY_PORT", "43191")

# Colors
GREEN := '\033[0;32m'
YELLOW := '\033[1;33m'
BLUE := '\033[0;34m'
RED := '\033[0;31m'
NC := '\033[0m'

# Default recipe - show grouped help.
default:
  @just --list --unsorted

# =============================================================================
# ALIASES
# =============================================================================
# Recipes are grouped by prefix (dashboard-*, pi-*). Short shortcuts only.

# quality
alias v := verify

# run everything
alias r := run

# dashboard-*  (d + first letter of the sub-command)
alias db := dashboard-build
alias dd := dashboard-dev
alias di := dashboard-install
alias dt := dashboard-typecheck
alias dtu := dashboard-test-unit
alias dtc := dashboard-test-coverage
alias de2e := dashboard-test-e2e
alias dv := dashboard-verify
alias ds := dashboard-serve
alias rb := review-build

# pi-*
alias pd := pi-dev
alias pr := pi-reload
alias ps := pi-symlink
alias prd := pi-reload-dry-run

# package/release
alias pk := pack-dry-run
alias pkf := pack-dry-run-fast
alias pp := prepack

# =============================================================================
# SETUP & INFO
# =============================================================================

# Show grouped command help.
[group('setup')]
help:
  @just --list --unsorted

# Print project paths and runtime settings.
[group('setup')]
info:
  @printf "{{BLUE}}pi-hive paths{{NC}}\n"
  @printf "  repo:              %s\n" "{{justfile_directory()}}"
  @printf "  extension sync:    %s\n" "{{extension_dir}}"
  @printf "  dashboard source:  %s\n" "{{dashboard_dir}}"
  @printf "  telemetry default: http://{{telemetry_host}}:{{telemetry_port}}\n"

# Install all local development dependencies.
[group('setup')]
install:
  @printf "{{YELLOW}}Installing extension dependencies...{{NC}}\n"
  npm install
  @printf "{{YELLOW}}Installing dashboard dependencies...{{NC}}\n"
  cd {{dashboard_dir}} && npm install
  @printf "{{GREEN}}Install complete.{{NC}}\n"

# Project the dashboard points at when run standalone. Defaults to the demo
# playground so `just run` shows the seeded OpenSpec changes out of the box.
project := env_var_or_default("PROJECT", env_var("HOME") + "/Projects/pi-hive-playground")

# Run this checkout as a temporary Pi extension for manual testing.
[group('pi')]
pi-dev:
  pi -e .

# Vite proxies /api, /plans, /pl-review, /stream, … to the Bun server; edit
# ui/web/src/** and see changes live (Ctrl+C stops both). Vite binds to
# localhost/::1, not 127.0.0.1. Usage: `just run`  or  `PROJECT=/path just run`.
# Run EVERYTHING: Bun server (API + /pl-review) + Vite HMR frontend. Open http://localhost:43192.
# The server always mints/reuses a bearer credential; manual development never
# disables mutation authentication.
[group('dashboard')]
run:
  cd {{dashboard_dir}} && npm install
  @printf "{{BLUE}}pi-hive dashboard (dev){{NC}}\n"
  @printf "  project:  %s\n" "{{project}}"
  @printf "  frontend: http://localhost:43192  (HMR — open this)\n"
  @printf "  api:      http://{{telemetry_host}}:{{telemetry_port}} (authenticated writes)\n"
  npx concurrently --kill-others --names "api,web" --prefix-colors "blue,green" \
    "HIVE_TELEMETRY_HOST={{telemetry_host}} HIVE_TELEMETRY_PORT={{telemetry_port}} HIVE_PROJECT_CWD={{project}} HIVE_TELEMETRY_DB={{project}}/.telemetry/telemetry.db bun src/observability/server/index.ts" \
    "cd {{dashboard_dir}} && HIVE_TELEMETRY_PORT={{telemetry_port}} npm run dev"

# Serve the dashboard standalone: ONE authenticated Bun process (API + built
# dist/ + /pl-review), no Vite/HMR. For a quick check of the built UI.
[group('dashboard')]
dashboard-serve:
  @printf "{{BLUE}}pi-hive dashboard (serve){{NC}}\n"
  @printf "  project:   %s\n" "{{project}}"
  @printf "  dashboard: http://{{telemetry_host}}:{{telemetry_port}}  (authenticated writes)\n"},{
  HIVE_TELEMETRY_HOST="{{telemetry_host}}" HIVE_TELEMETRY_PORT="{{telemetry_port}}" \
    HIVE_PROJECT_CWD="{{project}}" HIVE_TELEMETRY_DB="{{project}}/.telemetry/telemetry.db" \
    bun src/observability/server/index.ts

# Restart the dashboard so it serves the synced bundle; then run /reload in Pi.
# Sync this checkout into the user extension dir + reload.
[group('pi')]
pi-reload:
  mkdir -p "{{extension_dir}}"
  rsync -a --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude 'ui/web/node_modules/' \
    --exclude '*.tgz' \
    --exclude '.pi/' \
    --exclude '.env' \
    --exclude '.env.*' \
    ./ "{{extension_dir}}/"
  @printf "{{GREEN}}Synced pi-hive to %s{{NC}}\n" "{{extension_dir}}"
  node scripts/restart-dashboard.mjs "{{extension_dir}}"
  @printf "Run /reload in Pi to load the synced extension commands/hooks.\n"

# Moves an existing copied extension aside once, then points Pi at this repo.
# Symlink this checkout into the user extension dir for live development.
[group('pi')]
pi-symlink:
  #!/usr/bin/env bash
  set -euo pipefail
  target="{{extension_dir}}"
  source="{{justfile_directory()}}"
  mkdir -p "$(dirname "$target")"
  if [ -L "$target" ]; then
    current="$(readlink "$target")"
    if [ "$current" = "$source" ]; then
      printf "{{GREEN}}pi-hive already symlinked to %s{{NC}}\n" "$source"
    else
      rm "$target"
      ln -s "$source" "$target"
      printf "{{GREEN}}Updated pi-hive symlink: %s -> %s{{NC}}\n" "$target" "$source"
    fi
  elif [ -e "$target" ]; then
    # Keep backups outside ~/.pi/agent/extensions. Pi auto-discovers any
    # extensions/*/index.ts directory, so in-place backups register duplicate
    # commands such as /hive-plan:1 and /hive-plan:2.
    backup_dir="$(dirname "$(dirname "$target")")/extension-backups"
    mkdir -p "$backup_dir"
    backup="$backup_dir/$(basename "$target").$(date +%Y%m%d%H%M%S)"
    mv "$target" "$backup"
    ln -s "$source" "$target"
    printf "{{YELLOW}}Moved existing extension to %s{{NC}}\n" "$backup"
    printf "{{GREEN}}Created pi-hive symlink: %s -> %s{{NC}}\n" "$target" "$source"
  else
    ln -s "$source" "$target"
    printf "{{GREEN}}Created pi-hive symlink: %s -> %s{{NC}}\n" "$target" "$source"
  fi
  node scripts/restart-dashboard.mjs "$target"
  printf "Run /reload in Pi once to load the symlinked extension; file edits are then live from this checkout.\n"

# Show what reload would copy/delete without changing the live extension.
[group('pi')]
pi-reload-dry-run:
  mkdir -p "{{extension_dir}}"
  rsync -ani --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude 'ui/web/node_modules/' \
    --exclude '*.tgz' \
    --exclude '.pi/' \
    --exclude '.env' \
    --exclude '.env.*' \
    ./ "{{extension_dir}}/"

# =============================================================================
# DASHBOARD
# =============================================================================

# Install dashboard dependencies only.
[group('dashboard')]
dashboard-install:
  cd {{dashboard_dir}} && npm install

# Rebuild the committed dashboard bundle and stamp dist/.
[group('dashboard')]
dashboard-build:
  cd {{dashboard_dir}} && npm install && npm run build

# Build the committed, review-only UI and deterministic gzip artifacts.
[group('dashboard')]
review-build:
  node scripts/build-review-bundle.mjs

# Run the root extension TypeScript checker.
[group('quality')]
typecheck-core:
  cd {{dashboard_dir}} && npm install && ./node_modules/.bin/tsc -p ../../tsconfig.json

# Run the dashboard type checker.
[group('dashboard')]
dashboard-typecheck:
  cd {{dashboard_dir}} && npm run typecheck

# Run dashboard component tests in jsdom.
[group('dashboard')]
dashboard-test-unit:
  cd {{dashboard_dir}} && npm run test:unit

# Generate dashboard unit-test coverage reports.
[group('dashboard')]
dashboard-test-coverage:
  cd {{dashboard_dir}} && npm run test:coverage

# Run dashboard browser workflows and axe accessibility checks.
[group('dashboard')]
dashboard-test-e2e:
  cd {{dashboard_dir}} && npm run test:e2e

# Verify the committed dashboard bundle matches source.
[group('dashboard')]
dashboard-verify:
  node scripts/check-dashboard-fresh.mjs

# Start the dashboard Vite dev server.
[group('dashboard')]
dashboard-dev:
  cd {{dashboard_dir}} && npm run dev

# =============================================================================
# QUALITY
# =============================================================================

# Run the Node test suite.
[group('quality')]
test:
  node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/*.test.ts

# Separate from `test` because db.ts uses bun:sqlite and the core must load
# without Bun (*.spec.ts so the Node runner never picks them up).
# Run the Bun-only test suite (SQLite layer, dashboard security).
[group('quality')]
test-db:
  bun test ./tests/*.spec.ts

# Generate Node coverage for the Bun-independent extension modules.
[group('quality')]
coverage-core:
  rm -rf coverage/core
  npx c8 --all --check-coverage --lines=85 --branches=80 --include='src/**/*.ts' --exclude='src/observability/db.ts' --exclude='src/observability/server/**' --reporter=text-summary --reporter=json-summary --reporter=json --reporter=lcov --reports-dir=coverage/core --temp-directory=coverage/.tmp/core node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/*.test.ts
  node scripts/check-critical-coverage.mjs
  rm -rf coverage/.tmp

# Generate Bun coverage for SQLite and dashboard-server modules.
[group('quality')]
coverage-db:
  rm -rf coverage/bun
  bun test --coverage --coverage-reporter=text --coverage-reporter=lcov --coverage-dir=coverage/bun ./tests/*.spec.ts
  node scripts/check-bun-coverage.mjs

# Produce all machine-readable coverage reports consumed by CI.
[group('quality')]
coverage: coverage-core coverage-db dashboard-test-coverage
  @printf "{{GREEN}}Coverage reports generated under coverage/.{{NC}}\n"

# Verify package manifest, required files, peer deps, and committed build stamps.
[group('quality')]
verify-package:
  node scripts/verify-package-files.mjs

# Enforce packed/unpacked package and review-bundle byte budgets.
[group('quality')]
verify-budgets:
  node scripts/check-package-budgets.mjs

# Run tests plus verification gates, without packaging dry-run.
[group('quality')]
verify: typecheck-core dashboard-typecheck dashboard-test-unit dashboard-test-e2e test test-db dashboard-verify verify-package verify-budgets
  @printf "{{GREEN}}All verification gates passed.{{NC}}\n"

# Run all local release/CI gates, including packaging dry-run.
[group('quality')]
ci: typecheck-core dashboard-typecheck dashboard-test-unit dashboard-test-e2e test test-db dashboard-verify verify-package verify-budgets pack-dry-run
  @printf "{{GREEN}}CI gates passed.{{NC}}\n"

# =============================================================================
# PACKAGE & RELEASE
# =============================================================================

# Rebuild committed UIs and run package verification, matching package prepack.
[group('package')]
prepack: dashboard-build review-build verify-package verify-budgets
  @printf "{{GREEN}}Prepack checks passed.{{NC}}\n"

# Run publish-time checks.
[group('package')]
prepublish: test dashboard-verify verify-package verify-budgets
  @printf "{{GREEN}}Prepublish checks passed.{{NC}}\n"

# Inspect package contents. Runs the package prepack hook.
[group('package')]
pack-dry-run:
  npm pack --dry-run

# Inspect package contents quickly without running package hooks.
[group('package')]
pack-dry-run-fast:
  npm pack --dry-run --ignore-scripts

# =============================================================================
# MAINTENANCE
# =============================================================================

# Remove local dashboard dependencies and package artifacts.
[group('maintenance')]
clean:
  rm -rf {{dashboard_dir}}/node_modules
  rm -f *.tgz
  @printf "{{GREEN}}Cleaned local dependencies/artifacts.{{NC}}\n"

# Show current repository status.
[group('maintenance')]
status:
  git status --short
