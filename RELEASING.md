# Releasing pi-hive

## One-time repository configuration

The `Release` workflow publishes through the protected `npm` GitHub environment.
Keep at least one required reviewer on that environment. In npm package settings,
configure a **GitHub Actions trusted publisher** for:

- organization/user: `demetere`
- repository: `pi-hive`
- workflow: `release.yml`
- environment: `npm`
- allowed action: `npm publish`

With an authenticated npm CLI 11.15 or newer, the equivalent configuration is:

```sh
npm trust github pi-hive --repo demetere/pi-hive --file release.yml \
  --env npm --allow-publish
```

The workflow intentionally has no `NPM_TOKEN` fallback. npm authenticates it with
GitHub OIDC and records provenance for the published package.

## Release process

1. Update `package.json` and `package-lock.json` to the same version.
2. Move relevant entries from **Unreleased** in `CHANGELOG.md` into a heading of
   the form `## [x.y.z] - YYYY-MM-DD`.
3. Run `just release-gate` and commit all generated output. This aggregate runs
   coverage, the complete CI/package/generated/install/license gate, the exact
   root audit policy (including its dated exception), and the dashboard audit.
4. Create and push the matching tag (`vx.y.z`) from the clean release commit.
5. Publish a GitHub Release with maintained release notes. Publishing the release
   starts the protected `Release` workflow; approve its `npm` environment job.

For an existing GitHub Release and tag, the workflow can be retried with:

```sh
gh workflow run Release -f tag=vx.y.z
```

Before npm publish, the workflow runs `just release-gate`, verifies the tag and
package versions, release notes, dashboard build stamp, exact npm tarball
allowlist and byte budgets, license notices, both dependency audits, coverage,
and a clean Git index/worktree. It then generates and validates both SBOMs, the
dependency/build manifest, and checksums, and uploads those validated artifacts
before npm publish while every failure is still reversible and rerunnable.
Direct `npm publish` invokes the same aggregate, unchanged tagged-state verification,
artifact generation, and artifact validation through `prepublishOnly`; the protected
workflow uses `--ignore-scripts` only after it has already run those exact gates on
the tagged checkout, avoiding lifecycle recursion and duplicate work.

Successful releases upload the prevalidated two CycloneDX SBOMs, dependency/build
manifest, and `SHA256SUMS` to the GitHub Release before npm publish.
