# Auto-updates — publisher + admin guide

How the in-app updater works, what to publish for every release, and how to turn it off for a locked-down install.

## What ships in v0.1.3+

The updater is GitHub-Releases-driven. On startup (after a 30s grace period, then every 4h) Cerebro hits `api.github.com/repos/AgenticFirst/Cerebro/releases/latest`, picks the asset that matches the user's OS + CPU, downloads it to `<userData>/updates/`, verifies it, and shows a banner. The user explicitly clicks **Update now** → the binary is replaced atomically, with a 2-second launch verification and hard rollback if the new version doesn't survive that window.

The bits worth knowing:

- **Failure isolation.** Your data (SQLite, settings, memory, chat history) lives in `<userData>` and is never touched by the updater. The single mutation the updater performs is a `rename(<downloaded>, $APPIMAGE)`, preceded by a verified `.bak` copy. If anything goes wrong after the rename, the `.bak` is restored.
- **Bounded failure.** Every IPC handler completes within 30s + transfer time. The "Error invoking remote method 'X': reply was never sent" failure mode from v0.1.x is structurally impossible in v0.1.3+ — handlers return a discriminated `UpdateActionResult`, never throw.
- **Audit log.** Every significant event lands in `<userData>/logs/updater.log` as JSON lines (one event per line). Rotated at 1 MB, kept 5 generations.

## What to publish for every release

For each GitHub Release tag `vX.Y.Z`:

1. Build artifacts via `npm run make` for each platform. Forge produces:
   - `Cerebro-X.Y.Z-x64.AppImage`, `Cerebro-X.Y.Z-arm64.AppImage`, plus `.deb` / `.rpm` on Linux.
   - `Cerebro-X.Y.Z-arm64.dmg`, `Cerebro-X.Y.Z-x64.dmg` on macOS.
   - `Cerebro-X.Y.Z Setup.exe` on Windows.
2. **Publish a SHA-256 companion file for every artifact.** This unlocks integrity verification in the in-app updater — without it the updater can still catch size / magic-bytes corruption but won't catch a same-size, same-magic-byte tampered binary.

   ```bash
   for f in Cerebro-*.AppImage Cerebro-*.dmg "Cerebro-* Setup.exe" cerebro_*.deb cerebro-*.rpm; do
     [ -f "$f" ] || continue
     shasum -a 256 "$f" > "$f.sha256"
   done
   ```

   Upload the `*.sha256` files as additional release assets alongside the binaries.

3. Alternative: embed hashes in the release notes (the updater also parses `<hex64>  <asset-name>` lines and `<asset-name>: <hex64>` lines from `release.body`). Sibling `.sha256` assets are preferred — release notes can be edited after the fact, sibling assets are stable.

4. After publishing, do scenario #1 of the **Hard pre-ship gate** below on a real Ubuntu 22.04 desktop. We do not tag a release without a happy-path smoke.

## Hard pre-ship gate

Before tagging any release, run all six on a real Ubuntu 22.04 desktop VM (a container won't work — AppImage launch + 2-second verify need a real session bus and X/Wayland):

1. **Happy path** — download → verify → apply → restart → new version comes up.
2. **Verification rejection** — host a fake release with a truncated AppImage; updater rejects before apply; the partial is deleted; Retry against the real asset succeeds.
3. **Hung connection** — fake server accepts the request but never writes body. The initial-byte timeout fires within 30s. Banner shows the calm "took too long" copy. Retry works.
4. **Mid-download stall** — fake server sends one byte then stalls. Stall watchdog fires within 30s. Same recovery as #3.
5. **Broken new version** — a fake AppImage that exits immediately on launch. Rollback fires. Banner shows the reassurance copy. The running version is byte-identical to before the attempt (verified with `sha256sum`).
6. **Admin opt-out** — `CEREBRO_DISABLE_AUTO_UPDATES=1 cerebro` → no banner, no poll, no IPC traffic on update channels.

## Admin opt-out

For enterprise installs that manage updates externally (`apt`, MDM, Ansible, etc.), set `CEREBRO_DISABLE_AUTO_UPDATES=1` in the environment Cerebro launches under. Anything other than `""`, `"0"`, or `"false"` counts as enabled — so `1`, `true`, `yes`, and `on` all work.

The flag disables:
- The 4-hour update poll.
- The renderer's update banner (it doesn't even subscribe to update events).
- Every `update:*` IPC handler returns `{ ok: false, kind: 'disabled', error: 'Auto-updates disabled by administrator' }`.

Bake the env var into the launcher: a systemd unit `Environment=CEREBRO_DISABLE_AUTO_UPDATES=1`, a `.desktop` file `Exec=env CEREBRO_DISABLE_AUTO_UPDATES=1 cerebro`, or a wrapper script on `$PATH`.

## Support diagnostics

If a user reports a failed update, ask for `<userData>/logs/updater.log`. On Linux that's `~/.config/Cerebro/logs/updater.log`; on macOS `~/Library/Application Support/Cerebro/logs/updater.log`; on Windows `%APPDATA%/Cerebro/logs/updater.log`. The log contains one JSON line per significant event with timestamps, version, asset name, and outcome — no PII, no URLs beyond the GitHub release tag.

Typical happy-path sequence:

```
{"ts":"…","appVersion":"0.1.2","event":"check"}
{"ts":"…","appVersion":"0.1.2","event":"available","remoteVersion":"0.1.3","asset":"Cerebro-0.1.3-x64.AppImage"}
{"ts":"…","appVersion":"0.1.2","event":"download_start","asset":"Cerebro-0.1.3-x64.AppImage","resumeFrom":0,"total":250000000}
{"ts":"…","appVersion":"0.1.2","event":"verify_ok","asset":"Cerebro-0.1.3-x64.AppImage"}
{"ts":"…","appVersion":"0.1.2","event":"download_complete","asset":"Cerebro-0.1.3-x64.AppImage"}
{"ts":"…","appVersion":"0.1.2","event":"apply_start","asset":"Cerebro-0.1.3-x64.AppImage","platform":"linux"}
{"ts":"…","appVersion":"0.1.2","event":"apply_ok","asset":"Cerebro.AppImage","mode":"appimage"}
```

A rollback shows as `apply_rollback` with `rolledBack: true` and the underlying launch-failure reason in `error`.
