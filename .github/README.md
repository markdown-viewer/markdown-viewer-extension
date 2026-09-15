# Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | push to `main`, pull requests | Unit/contract tests via `npm run test:unit`, plus installed-extension E2E via `npm run test:e2e` on Node.js + Playwright |
| `release.yml` | push of a `v<version>` tag, manual run | Builds every platform and attaches the installers to the GitHub Release |

## Cutting a release

1. Bump `"version"` in `package.json` and commit it on `main`.
   Every build script copies that version into its own manifest
   (`chrome/manifest.json`, `edge/manifest.json`, `firefox/manifest.json`,
   `obsidian/manifest.json`, `mobile/pubspec.yaml`, and the VS Code
   `package.json`), so the tag and the manifests cannot drift apart.
2. Push the tag: `git tag v5.4.0 && git push origin v5.4.0`.
   The tag must be `v` plus the `package.json` version, otherwise `release.yml`
   stops in its `prepare` job before building anything.
3. Watch the run. Re-run it from the Actions tab (`workflow_dispatch`, with the
   tag name as input) to rebuild a release — assets are overwritten with
   `gh release upload --clobber`, so re-runs are safe.

## What a release contains

| Asset | Platform | Built by |
|-------|----------|----------|
| `chrome-v<version>.zip` | Chrome / Chromium | `npm run build:chrome` |
| `edge-v<version>.zip` | Microsoft Edge | `npm run build:edge` |
| `firefox-v<version>.zip` | Firefox | `npm run build:firefox` |
| `vscode-v<version>.vsix` | VS Code / Open VSX | `npm run build:vscode` |
| `obsidian-v<version>.zip` | Obsidian (bundle) | `npm run build:obsidian` |
| `main.js`, `manifest.json`, `styles.css` | Obsidian (registry files) | `npm run build:obsidian` |
| `documd-cli-v<version>.tgz` | HTML CLI (npm tarball) | `npm run build:cli` |
| `android-v<version>.apk` / `.aab` | Mobile app | `node mobile/build-app.js android` |

## Two releases per version

Obsidian resolves plugin updates through `releases/download/<version>/main.js`
and reads the manifest from `releases/latest/download/manifest.json`, so it needs
a release whose tag is the bare version. Every stable release therefore also
publishes a small release tagged `5.4.0` holding only the three plugin files and
carrying the Latest marker; the `v5.4.0` release is the main one (all platforms)
and is published explicitly without that marker.

Prerelease tags (`v5.4.0-beta.1`) skip the Obsidian release, so beta builds never
reach Obsidian users.

Both releases are created as drafts and published only after every build job
succeeded, so a failed build never leaves an incomplete release visible.

## Builds that fail silently if assets are missing

Some platform builds only warn when a Slidev asset is absent and then ship
without Slidev support. `release.yml` builds those assets explicitly and asserts
them in the artifacts:

- `npm run build:vscode` needs `npm run build:slidev` and
  `npx tsx slidev-shell/build-themes.ts` to have run first.
- `npm run build:obsidian` reads `dist/vscode/webview/slidev-shell-inline.html`
  and `slidev-theme-bundles.json`, so it needs a VS Code build first.
- `npm run build:mobile` needs `dist/slidev-shell-vscode` and `dist/themes`.

## Android signing

Without secrets the APK is debug-signed (side-loadable, rejected by the Play
Store) and the AAB is skipped, matching what `node mobile/build-app.js android`
does locally. To produce Play Store artifacts, add these repository secrets:

- `ANDROID_KEYSTORE_BASE64` — `base64 -i mobile/android/markdown_viewer.keystore`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS` (`markdown_viewer`)
- `ANDROID_KEY_PASSWORD`

## Not automated

- iOS and macOS builds: they need a macOS runner plus Apple certificates and
  provisioning profiles.
- Store submissions: Chrome Web Store, Edge Add-ons, AMO, VS Code Marketplace,
  Open VSX, npm, Play Store / App Store.

## Local workflow validation

```bash
docker run --rm -v "$PWD:/repo" --workdir /repo rhysd/actionlint:latest
```
