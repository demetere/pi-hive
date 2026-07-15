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
3. Run `just ci` and commit all generated output.
4. Create and push the matching tag (`vx.y.z`) from the clean release commit.
5. Publish a GitHub Release with maintained release notes. Publishing the release
   starts the protected `Release` workflow; approve its `npm` environment job.

For an existing GitHub Release and tag, the workflow can be retried with:

```sh
gh workflow run Release -f tag=vx.y.z
```

Before npm publishing, the workflow verifies the tag and package versions,
release notes, dashboard build stamp, Plannotator vendor and review-bundle hashes,
and a clean Git index/worktree. Direct `npm publish` runs the same release check,
all TypeScript projects, Node tests, and Bun tests through `prepublishOnly`.

Successful releases attach two CycloneDX SBOMs, a dependency/build manifest, and
`SHA256SUMS` to the GitHub Release.
