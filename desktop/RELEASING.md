# Releasing the macOS app

The app ships from CI. After Changesets publishes a release, `release.yml` dispatches
`desktop-release.yml`, which builds, signs, notarizes and uploads
`aio-proxy-<version>-arm64.dmg` to the `v<version>` Release, then replaces the Sparkle feed
`appcast.xml` on the `desktop-feed` prerelease. Canary releases never ship the app.

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
   desktop/.cache/sparkle-2.10.0/bin/generate_keys --account aio-proxy-desktop
   desktop/.cache/sparkle-2.10.0/bin/generate_keys --account aio-proxy-desktop -x sparkle-private.key
   ```

   (`bun run desktop:bundle --unsigned` downloads `desktop/.cache` first.)
   - Repository variable `SPARKLE_PUBLIC_ED_KEY`: the printed public key.
   - Repository secret `SPARKLE_ED_PRIVATE_KEY`: the contents of `sparkle-private.key`. Delete the file afterwards.

   CI passes the key to `generate_appcast` only on stdin. Do not use `--account` in automation:
   it blocks on a Keychain prompt.

## Native development

The desktop host is a Go module using MyGo native UI, not a web frontend. Its minimum platform remains macOS 13 on Apple silicon. Install the pinned Go toolchain with `mise -C desktop install`; `mise -C desktop exec -- go test ./...` runs the desktop tests. A bundled build injects the product version from `npm/aio-proxy/package.json`; plain `go run .` reports `0.0.0-dev` and runs read-only outside an installed bundle. Rust is no longer needed.

The native panel tests include real Metal corner coverage in light and dark modes. That test uses an isolated temporary SDK adapter and never modifies the installed MyGo module or shipped binary; only a missing Metal device skips it. `CapturePage` renders the last scene on the CPU, so it is not proof of native GPU clipping.

The footer menu regression opens a real AppKit window and menu, sends a native mouse press to the footer, and selects a command. It checks that menu tracking starts after the surface frame returns, disabled commands stay disabled, and selection dispatches once; it also exercises and reloads a Menu Bar Display choice in an isolated home. Run it in a graphical macOS session; it needs no Accessibility permission and does not start or stop the proxy.

Menu Bar Display preferences persist independently of service-install permissions. When Today Tokens or Tokens per Second is selected, an independent 15-second authenticated summary poll keeps the menu-bar text current with the panel closed. Tokens per Second measures accounted-token throughput between samples, not partial-stream generation speed. Icon-only mode stops those polls; requests are cancelled on app exit or instance change.

Menu-bar text uses AppKit's monospaced-digit system font in a template image: 9 pt stacked TPS/TOK rows or one centered 12 pt row. Verify it on the actual menu bar, including one-metric and hidden-icon states; the native status-item title remains empty, and the image remains 18 pt high. Neither a software panel capture nor a formatted string proves this layout.

The bundle layout, Icon Composer assets, Bun sidecar, Sparkle appcast and signing keys stay unchanged. Sparkle and ServiceManagement are loaded through purego at runtime. Native framework downloads live in `desktop/.cache`, not `vendor` (which Go reserves for module vendoring).

## Local rehearsal (no publishing)

Bundling needs Xcode 26 on macOS 26 (its `actool` compiles the app icon); select it with
`xcode-select` or `DEVELOPER_DIR`. It also needs the Go toolchain named in `desktop/go.mod`
(`mise -C desktop install` provides it; use `mise -C desktop exec -- bun run desktop:bundle` if Go is not on your PATH). Store the notary credentials once, with
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
