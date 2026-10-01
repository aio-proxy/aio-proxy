# Releasing the macOS app

The app ships from CI. After Changesets publishes a release, `release.yml` dispatches
`desktop-release.yml`, which builds, signs, notarizes and uploads
`aio-proxy-<version>-arm64.dmg` to the `v<version>` Release, then replaces the Sparkle feed
`appcast.xml` on the `desktop-feed` prerelease. Canary releases never ship the app.

## One-time setup

The signing and notarization secrets are the organization's `APPLE_*` secrets, shared with the
rest of the organization; the repository must be in their access list. The workflow maps them to
the names the scripts read (the same names a local release sets).

1. **Developer ID certificate.** In an Apple Developer Program team, create a "Developer ID
   Application" certificate and export it with its private key as a `.p12`.
   - Secret `APPLE_CERTIFICATE_BASE64`: the output of `base64 -i developer-id.p12`.
   - Secret `APPLE_CERTIFICATE_PASSWORD`: the export password.
   - Secret `APPLE_SIGN_IDENTITY`: the certificate name, e.g. `Developer ID Application: <Team> (<TEAMID>)`.
2. **Notarization.** In App Store Connect → Users and Access → Integrations, create an API key
   with the Developer role.
   - Secret `APPLE_NOTARY_KEY_BASE64`: the output of `base64 -i AuthKey_<KEYID>.p8`.
   - Secret `APPLE_NOTARY_KEY_ID`: the key ID.
   - Secret `APPLE_NOTARY_ISSUER_ID`: the issuer ID.

   `APPLE_TEAM_ID` and `APPLE_PROFILE_BASE64` are not used: the identity names the team, and the
   app has no restricted entitlement that needs a provisioning profile.

3. **Sparkle update key.** This key is the update root of trust: whoever holds the private key
   can ship an update to every install. Losing it means existing installs can never be updated
   again. Keep one offline backup, and never change it once a version has shipped.

   ```bash
   desktop/vendor/sparkle-2.10.0/bin/generate_keys --account aio-proxy-desktop
   desktop/vendor/sparkle-2.10.0/bin/generate_keys --account aio-proxy-desktop -x sparkle-private.key
   ```

   (`bun run desktop:bundle --unsigned` downloads `desktop/vendor` first.)
   - Repository variable `SPARKLE_PUBLIC_ED_KEY`: the printed public key.
   - Repository secret `SPARKLE_ED_PRIVATE_KEY`: the contents of `sparkle-private.key`. Delete the file afterwards.

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

After each release, check Actions → "Desktop release". It is a separate run, so a failure there
does not fail the release run and may notify no one. Re-dispatch any tag whose run failed or was
cancelled (a newer pending dispatch cancels an older pending one) with
`gh workflow run desktop-release.yml -f tag=v<version>`.
The job runs only for a tag that is a published (non-draft, non-prerelease) Release whose commit
is on `main`, and it builds that commit; any other tag stops before checkout, so release secrets
never reach unreviewed code.
If the DMG is already on the Release, the job reuses and re-verifies it: a published version is
never rebuilt or replaced. If the feed already offers the version, the job re-verifies that
item. If the feed already offers something newer, the older version is not added.

If `desktop-feed` exists but has no `appcast.xml`, or one with no items, the job stops. There is no
appcast backup: delete the `desktop-feed` Release to start a fresh feed (installed apps only need
the newest item).

The job checks the key pair first, before building and before uploading anything: the public key
derived from `SPARKLE_ED_PRIVATE_KEY`, `SPARKLE_PUBLIC_ED_KEY` and the DMG's `SUPublicEDKey` must
all be equal. It also refuses to upload when the feed already lists the version but the DMG is not
on the Release, and to replace the feed when the new item has no valid EdDSA signature
(`generate_appcast` itself only warns when the key does not match).
