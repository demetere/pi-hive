set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

extension_dir := env_var_or_default("PI_HIVE_EXTENSION_DIR", env_var("HOME") + "/.pi/agent/extensions/pi-hive")

# List available commands.
default:
  @just --list

# Run this checkout as a temporary Pi extension for manual testing.
dev:
  pi -e .

# Copy this checkout into the user-level Pi extension directory.
# Mirrors Pi's /reload workflow: sync here, then run /reload in Pi.
reload:
  mkdir -p "{{extension_dir}}"
  rsync -a --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude 'ui/web/node_modules/' \
    --exclude '*.tgz' \
    --exclude '.pi/' \
    --exclude '.atl/' \
    --exclude '.env' \
    --exclude '.env.*' \
    ./ "{{extension_dir}}/"
  @echo "Synced pi-hive to {{extension_dir}}"
  @echo "Run /reload in Pi to load the synced extension."

# Show what reload would copy/delete without changing the live extension.
reload-dry-run:
  mkdir -p "{{extension_dir}}"
  rsync -ani --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude 'ui/web/node_modules/' \
    --exclude '*.tgz' \
    --exclude '.pi/' \
    --exclude '.atl/' \
    --exclude '.env' \
    --exclude '.env.*' \
    ./ "{{extension_dir}}/"

# Rebuild the committed dashboard bundle.
build-dashboard:
  npm run build:dashboard

# Verify the committed dashboard bundle matches source.
verify-dashboard:
  npm run verify:dashboard

# Inspect package contents without creating a tarball.
pack-dry-run:
  npm pack --dry-run --ignore-scripts
