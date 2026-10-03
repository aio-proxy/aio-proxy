# Releasing the desktop app

The app ships from CI. After Changesets publishes a release, `release.yml` dispatches
`desktop-release.yml`, which runs two independent paths. Canary releases never ship the app.

- macOS: builds, signs, notarizes and uploads `aio-proxy-<version>-arm64.dmg` to the
  `v<version>` Release, then replaces the Sparkle feed `appcast.xml` on the `desktop-feed`
  prerelease.
- Linux and Windows: `verify` checks the tag, then `build-linux` (x86_64 on `ubuntu-22.04`,
  aarch64 on `ubuntu-22.04-arm`) and `build-windows` build unsigned bytes with no secrets.
  `publish-assets` (environment `desktop-release`) signs them with minisign and uploads
  `aio-proxy-<version>-x86_64.AppImage`, `aio-proxy-<version>-aarch64.AppImage` and
  `aio-proxy-<version>-x64-setup.exe`, each with a `.minisig`, to the `v<version>` Release. `feed`
  then points `latest.json` on `desktop-feed` at the highest version whose three assets all verify.

The Linux/Windows build jobs use no caches on purpose: bytes that get signed must not come from a
cache. Cold builds are slow (90 minute timeout).

## One-time setup

0. **Environment.** Create the `desktop-release` environment (Settings → Environments) with
   deployment branches limited to `main`. A workflow dispatch runs the chosen ref's copy of the
   workflow, and organization and repository secrets reach any ref, so only environment secrets
   keep the signing and update keys away from a branch's edited copy. Store every secret below as
   an environment secret under the same name (it takes precedence over an organization or
   repository secret of that name), then take this repository off the organization `APPLE_*`
   secrets' access list and delete the repository-level `SPARKLE_ED_PRIVATE_KEY`.

The signing and notarization secrets carry the organization's `APPLE_*` names. The workflow maps
them to the names the scripts read (the same names a local release sets).

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
   - `desktop-release` environment secret `SPARKLE_ED_PRIVATE_KEY` (see step 0): the contents of `sparkle-private.key`. Delete the file afterwards.

   The same key signs the Linux and Windows assets. `publish-assets` wraps the Sparkle Ed25519 key
   as a minisign key (prehashed `ED` signatures, trusted comment `aio-proxy-desktop <version> <target> <asset>`), so
   there is one update root of trust and no second secret. The Linux/Windows updater embeds the
   matching public key.

   CI passes the key to `generate_appcast` only on stdin. Do not use `--account` in automation:
   it blocks on a Keychain prompt.

## Local rehearsal (no publishing)

Bundling needs Xcode 26 on macOS 26 (its `actool` compiles the app icon); select it with
`xcode-select` or `DEVELOPER_DIR`. Store the notary credentials once, with
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
A `.dmg` it reuses from the Release must be signed, like the app and its CLI inside, by the
Team ID in `DEVELOPER_ID_IDENTITY`; anything else stops the job before the feed is touched.
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

## Windows code signing (optional)

Without signing, the installer triggers SmartScreen ("More info" then "Run anyway"); the README
says so. To sign, set `WINDOWS_SIGN_COMMAND` in the environment of the `build-windows` packaging
step. cargo-packager runs it per file with `%1` as the path, split on spaces, so the command
cannot contain quoted arguments with spaces. Either of these works:

- Azure Artifact Signing: `signtool sign /dlib <Azure.CodeSigning.Dlib.dll> /dmdf <metadata.json> /fd SHA256 /tr <timestamp-url> /td SHA256 %1`
- A certificate in the runner's store: `signtool sign /sha1 <thumbprint> /fd SHA256 /tr <timestamp-url> /td SHA256 %1`

cargo-packager signs the app, the installer and the uninstaller, but NOT the sidecar
`aio-proxy.exe` inside the install directory. The build job has no secrets today, so adding signing
means giving it the credentials (or moving the Windows package step behind the `desktop-release`
environment) deliberately.

## Resuming a failed Linux/Windows publish

Re-dispatch the tag the same way (`gh workflow run desktop-release.yml -f tag=v<version>`). The
workflow YAML always comes from `main` (the dispatch runs `--ref main` and the jobs refuse any other
ref), but the build and publish scripts are the tag's checkout, so a script fix on `main` does not
reach an older tag. "Re-run failed jobs" reuses the same run's artifacts; a fresh dispatch rebuilds.

`publish-assets` is resumable and never replaces a published asset. For each asset it signs and
uploads (`.minisig` first), or re-verifies a pair already on the Release. When only the `.minisig`
exists (a run died between the two uploads), it uploads this run's asset if it verifies against that
`.minisig` — always the case on "Re-run failed jobs", which reuses the same bytes — and otherwise
stops: a fresh dispatch rebuilt different bytes, so delete the orphan `.minisig` and dispatch again:

```bash
gh release delete-asset v<version> aio-proxy-<version>-x86_64.AppImage.minisig --repo aio-proxy/aio-proxy --yes
```

`feed` never creates `desktop-feed` (the macOS job does, and `feed` waits for that job whatever its outcome) and never moves the feed down;
a `latest.json` that does not parse fails the job. A failed or incomplete newer version leaves the
feed on the previous complete one.

A fork rehearsal must change the hard-coded `REPO` in `publish-assets.ts`, `publish-latest.ts` and
`publish.ts`; the `v<version>` Release and the `desktop-feed` prerelease must exist in the fork.

## Platform notes

- Windows installs per user to `%LOCALAPPDATA%\AIO Proxy`. A user uninstall removes the desktop-owned
  service, the `aiop` shims and the launch-at-login value; an upgrade (passive, silent or the
  interactive "uninstall before installing") keeps them.
- Linux has no uninstaller: run `aio-proxy service uninstall` before deleting the AppImage,
  otherwise the managed service keeps pointing at a file that is gone.
