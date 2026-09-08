# Platform release assets

The release script saves the four original platform tarballs before publishing
those files to npm. The workflow retains them as the `platform-tarballs` Actions
artifact for 30 days. After the GitHub Release exists, the independent `homebrew`
job uploads the tarballs and `SHA256SUMS`, then notifies `aio-proxy/homebrew-tap`.
Homebrew uses the GitHub Release URLs; npm installation is unchanged.

## Rollout

Merge the matching `homebrew-tap` updater change before enabling the new release
workflow. The updater accepts `source: github-release` and continues to accept
older npm notifications that have no source. Existing formula versions stay on
npm until a new release with attachments updates them.

## Retry

Rerun the failed `homebrew` job to reuse the original Actions artifact. Existing
Release attachments are checked against those files and never overwritten.
Avoid rerunning the build to recover an upload: repacking can produce different
bytes. If an attachment conflicts, restore the original artifact instead.

The tap's manual **Update Formula** workflow defaults to GitHub Release assets.
Choose `npm` for older versions that have no Release attachments.

## Missing or expired Actions artifact

If saving the artifact failed, or its retention period has expired, rerunning the
Homebrew job cannot recover it. Once npm serves the version, retrieve the already
published tarballs directly (do not build or pack the workspace again):

```sh
version=0.20.3 # replace with the failed release version
asset_dir=$(mktemp -d)
for platform in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  package="cli-$platform"
  curl --fail --location --retry 3 --connect-timeout 15 --max-time 120 \
    "https://registry.npmjs.org/@aio-proxy/$package/-/$package-$version.tgz" \
    --output "$asset_dir/$package-$version.tgz" || exit 1
done
bun run scripts/upload-release-assets.ts "$version" "$asset_dir" || exit 1
bun run scripts/homebrew-notify.ts "$version" "$asset_dir"
```

Run from the matching release's checkout, with `gh` authenticated for Release
uploads and `HOMEBREW_TAP_TOKEN` set for notification. The upload command refuses
conflicting existing attachments. This recovery path needs npm availability;
normal releases and retries with a retained artifact do not.
