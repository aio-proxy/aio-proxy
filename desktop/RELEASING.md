# Releasing the macOS app

The app ships from CI. After Changesets publishes a release, `release.yml` dispatches
`desktop-release.yml`, which builds, signs, notarizes and uploads
`aio-proxy-<version>-arm64.dmg` to the `v<version>` Release, then replaces the Sparkle feed
`appcast.xml` on the `desktop-feed` prerelease. Canary releases never ship the app.

## One-time setup

1. **Developer ID certificate.** In an Apple Developer Program team, create a "Developer ID
   Application" certificate and export it with its private key as a `.p12`.
   - Secret `DEVELOPER_ID_P12_BASE64`: the output of `base64 -i developer-id.p12`.
   - Secret `DEVELOPER_ID_P12_PASSWORD`: the export password.
   - Variable `DEVELOPER_ID_IDENTITY`: the certificate name, e.g. `Developer ID Application: <Team> (<TEAMID>)`.
2. **Notarization.** In App Store Connect → Users and Access → Integrations, create an API key
   with the Developer role.
   - Secret `APPLE_API_KEY_P8`: the downloaded `.p8` file's contents.
   - Secret `APPLE_API_KEY_ID`: the key ID.
   - Secret `APPLE_API_ISSUER_ID`: the issuer ID.
3. **Sparkle update key.** This key is the update root of trust: whoever holds the private key
   can ship an update to every install. Losing it means existing installs can never be updated
   again. Keep one offline backup, and never change it once a version has shipped.

   ```bash
   desktop/vendor/sparkle-2.10.0/bin/generate_keys --account aio-proxy-desktop
   desktop/vendor/sparkle-2.10.0/bin/generate_keys --account aio-proxy-desktop -x sparkle-private.key
   ```

   (`bun run desktop:bundle --unsigned` downloads `desktop/vendor` first.)
   - Variable `SPARKLE_PUBLIC_ED_KEY`: the printed public key.
   - Secret `SPARKLE_ED_PRIVATE_KEY`: the contents of `sparkle-private.key`. Delete the file afterwards.

   CI passes the key to `generate_appcast` only on stdin. Do not use `--account` in automation:
   it blocks on a Keychain prompt.

## Local rehearsal (no publishing)

Store the notary credentials once, with
`xcrun notarytool store-credentials aio-proxy-notary --apple-id <id> --team-id <TEAMID>`, then run:

```bash
sudo -v   # vmmap may need sudo to read a Developer ID hardened sidecar
DEVELOPER_ID_IDENTITY="Developer ID Application: <Team> (<TEAMID>)" \
NOTARY_PROFILE=aio-proxy-notary \
SPARKLE_PUBLIC_ED_KEY=<public key> \
bun run desktop:bundle --release
```

It ends with `desktop/target/bundle/aio-proxy-<version>-arm64.dmg`. Set `SPARKLE_FEED_URL` only
to rehearse an update against a local feed; `desktop:publish` refuses such a build.

## Resuming a failed desktop publish

Run `gh workflow run desktop-release.yml -f tag=v<version>`. The desktop publish is a separate
run under Actions → "Desktop release", so a failure there does not mark the release run failed.
If the DMG is already on the Release, the job reuses and re-verifies it: a published version is
never rebuilt or replaced. If the feed already offers the version, the job re-verifies that
item. If the feed already offers something newer, the older version is not added.

If `desktop-feed` exists but has no `appcast.xml`, the job stops: restore the file, or delete
the `desktop-feed` Release to deliberately start a fresh feed.

The job refuses to replace the feed when the new item has no valid EdDSA signature. The usual
cause is a `SPARKLE_ED_PRIVATE_KEY` that does not match `SPARKLE_PUBLIC_ED_KEY`, because
`generate_appcast` itself only warns in that case.
