import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerAppImage } from '@reforged/maker-appimage';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

// macOS code-signing configuration. We resolve the Developer ID Application
// identity from the keychain at build time so the config isn't tied to a
// specific developer's certificate hash. Notarization credentials live in
// the keychain profile created via:
//   xcrun notarytool store-credentials cerebro-notarytool \
//     --apple-id <email> --team-id <id> --password <app-specific-pw>
// If no Developer ID identity is found, we fall back to ad-hoc signing
// (the build still produces a launchable .app for local dev, but the DMG
// won't pass Gatekeeper for downloaded installs).
const NOTARIZE_KEYCHAIN_PROFILE = 'cerebro-notarytool';
const ENTITLEMENTS_PATH = path.join(__dirname, 'build', 'entitlements.mac.plist');

// Native node modules in `dependencies` that ship with .node binaries.
// `@electron-forge/plugin-vite` only packages the `.vite/` output —
// it does NOT copy node_modules into the packaged app. So our bundled
// main.js's `require('node-pty')` call resolves to nothing at runtime
// and the app crashes on launch with "Cannot find module 'node-pty'".
// We copy each entry below into Cerebro.app/Contents/Resources/app.asar.unpacked/
// node_modules/<name>/ during the postPackage hook, BEFORE signing,
// so osx-sign covers the bundled .node binaries with our entitlements.
const NATIVE_MODULES_TO_BUNDLE = ['node-pty'];

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(srcPath), destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function findDeveloperIdIdentity(): string | null {
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    const match = out.match(/"(Developer ID Application: [^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    // Has to stay `true` (boolean), not an object — @electron-forge/
    // plugin-vite has an internal check that breaks if this is an object.
    // The `unpack` glob we actually need (for native .node files) is
    // applied later by re-packing the asar in the postPackage hook,
    // see hooks.postPackage below.
    asar: true,
    // Bundles the Python backend + a relocatable CPython 3.11 (with all
    // backend deps installed) so the app can spawn its FastAPI server
    // without requiring Python on the user's machine. Both directories
    // are produced by scripts/bundle-python.sh and end up at
    // Cerebro.app/Contents/Resources/python-dist/ and .../backend/.
    // src/main.ts resolves them via process.resourcesPath when packaged.
    extraResource: [
      'build-resources/python-dist',
      'build-resources/backend',
    ],
    // forge-vite only places its bundled output in the build dir — it
    // does NOT include node_modules of externals like node-pty. We
    // copy them in here so they end up packed into app.asar; the
    // postPackage hook then re-packs the asar with `--unpack` to push
    // .node binaries out to app.asar.unpacked/. Without this two-step,
    // the bundled main.js's `require('node-pty')` fails at boot with
    // "Cannot find module 'node-pty'".
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        try {
          for (const moduleName of NATIVE_MODULES_TO_BUNDLE) {
            const src = path.join(__dirname, 'node_modules', moduleName);
            if (!fs.existsSync(src)) {
              console.warn(`[afterCopy] WARN native module ${moduleName} missing from node_modules — skipping`);
              continue;
            }
            const dest = path.join(buildPath, 'node_modules', moduleName);
            copyDirRecursive(src, dest);
            console.log(`[afterCopy] bundled native module: ${moduleName}`);
          }
          callback();
        } catch (err) {
          callback(err as Error);
        }
      },
    ],
    name: 'Cerebro',
    // Lowercase binary name. Forge's deb/rpm/AppImage makers all default
    // to looking for an executable named `package.json.name` (which is the
    // lowercase `cerebro`). Without this, makers fail with
    // "Could not find executable 'cerebro' in packaged application".
    executableName: 'cerebro',
    icon: './assets/icon',
    // Setting executableName above causes packager to also default
    // CFBundleDisplayName to the lowercase 'cerebro', which is what macOS
    // shows in Finder, Gatekeeper dialogs, and the Dock. Force it back to
    // the capitalized product name.
    appBundleId: 'app.cerebro.desktop',
    extendInfo: {
      CFBundleDisplayName: 'Cerebro',
    },
    // NOTE: We deliberately do NOT pass osxSign here. Forge's plugin
    // pipeline runs FusesPlugin (below) as a postPackage hook AFTER
    // packager's signing step, and Fuses rewrites the main binary —
    // which would invalidate any signature applied during packaging.
    // The hooks.postPackage step further down handles signing once
    // Fuses is done, which is the only point at which the bundle
    // contents are stable.
    //
    // Voice models (~480 MB) are deliberately NOT bundled — they're
    // downloaded on demand into the user's data dir from Settings → Voice.
    // Bundling them ballooned the DMG to 475 MB; lazy download brings the
    // installed app down to ~120 MB.
  },
  hooks: {
    // Runs before packaging — ensures build-resources/python-dist/ and
    // build-resources/backend/ exist (and are fresh if requirements.txt
    // changed). The script is idempotent: skips python-dist/ rebuild
    // when the requirements hash hasn't changed.
    async generateAssets() {
      const script = path.join(__dirname, 'scripts', 'bundle-python.sh');
      if (!fs.existsSync(script)) return;
      console.log('[generateAssets] running bundle-python.sh…');
      execFileSync('bash', [script], { stdio: 'inherit' });
    },
    // Runs AFTER all plugins (including Fuses) have modified the packaged
    // app. Three responsibilities on macOS:
    //   1. Force CFBundleDisplayName back to "Cerebro" — packager's
    //      executableName='cerebro' setting silently overrides extendInfo,
    //      leaving Finder and Gatekeeper showing "cerebro" lowercase.
    //   2. Sign with Developer ID Application + Hardened Runtime + the
    //      entitlements at build/entitlements.mac.plist. Has to happen
    //      AFTER Fuses or the signature is invalidated.
    //   3. Submit the .app to Apple's notary service via notarytool, wait
    //      for the ticket, then staple it to the bundle so the app passes
    //      Gatekeeper silently even when the user has no internet.
    // Falls back to ad-hoc signing when no Developer ID identity is in
    // the keychain — preserves the local-dev path without notarization.
    async postPackage(_forgeConfig, options) {
      if (options.platform !== 'darwin') return;
      const identity = findDeveloperIdIdentity();
      const isDeveloperId = identity !== null;
      console.log(
        `[postPackage] signing identity: ${isDeveloperId ? identity : 'ad-hoc (no Developer ID in keychain)'}`,
      );

      // Lazy-import @electron/osx-sign so non-macOS builds don't pay
      // the require cost. osx-sign walks the bundle in the right order
      // (inner dylibs → frameworks → helper apps → main app), which
      // `codesign --deep` does NOT do reliably — Apple's notary service
      // rejects --deep-signed bundles because it misses inner dylibs
      // like libEGL, libvk_swiftshader, libffmpeg, ShipIt, etc.
      // v2.x renamed `signAsync` → `sign` (which is still async).
      const osxSign = await import('@electron/osx-sign');
      const sign = (osxSign as any).sign ?? (osxSign as any).signAsync;

      // Re-pack app.asar with an unpack glob for native modules. This
      // can't be set as packagerConfig.asar.unpack (object form breaks
      // forge-vite — see comment there), so we extract + re-pack here.
      // After re-packing, we MUST update the Info.plist's
      // ElectronAsarIntegrity entry to the new asar's header hash.
      // packager originally computed and embedded the OLD asar's hash;
      // when EnableEmbeddedAsarIntegrityValidation is on, Electron
      // SIGTRAPs at boot if Info.plist's hash doesn't match the actual
      // asar (`Integrity check failed for asar archive (X vs Y)`).
      // The algorithm — SHA256 over `asar.getRawHeader(...).headerString`
      // — is taken from @electron/universal/dist/cjs/asar-utils.js's
      // `generateAsarIntegrity()`.
      const asarLib = await import('@electron/asar');
      const ASAR_UNPACK_GLOB = '*.node';
      for (const outputPath of options.outputPaths) {
        const appPath = path.join(outputPath, 'Cerebro.app');
        const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
        const tmpExtract = path.join(outputPath, '.asar-extract-tmp');
        fs.rmSync(tmpExtract, { recursive: true, force: true });
        asarLib.extractAll(asarPath, tmpExtract);
        const oldUnpacked = `${asarPath}.unpacked`;
        fs.rmSync(oldUnpacked, { recursive: true, force: true });
        fs.rmSync(asarPath, { force: true });
        // @electron/asar's unpack option uses minimatch with matchBase: true,
        // which matches by *basename* when the pattern has no slashes. So
        // `*.node` extracts all native binaries to .unpacked regardless of
        // depth. JS files stay in the archive (loadable from inside asar);
        // when node-pty's JS does require('./build/Release/pty.node'), the
        // asar layer transparently redirects to the .unpacked sibling.
        await asarLib.createPackageWithOptions(tmpExtract, asarPath, { unpack: ASAR_UNPACK_GLOB });
        fs.rmSync(tmpExtract, { recursive: true, force: true });

        const newHash = crypto
          .createHash('SHA256')
          .update(asarLib.getRawHeader(asarPath).headerString)
          .digest('hex');
        const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
        execFileSync('/usr/libexec/PlistBuddy', [
          '-c', `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${newHash}`,
          infoPlist,
        ]);
        console.log(`[postPackage] re-packed asar (unpack='${ASAR_UNPACK_GLOB}') + patched Info.plist hash → ${newHash.slice(0, 12)}…`);
      }

      for (const outputPath of options.outputPaths) {
        const appPath = path.join(outputPath, 'Cerebro.app');
        const plistPath = path.join(appPath, 'Contents', 'Info.plist');

        execFileSync('/usr/libexec/PlistBuddy', [
          '-c',
          'Set :CFBundleDisplayName Cerebro',
          plistPath,
        ]);

        if (isDeveloperId) {
          await sign({
            app: appPath,
            identity: identity!,
            hardenedRuntime: true,
            entitlements: ENTITLEMENTS_PATH,
            'entitlements-inherit': ENTITLEMENTS_PATH,
            'gatekeeper-assess': false,
            'pre-auto-entitlements': false,
            type: 'distribution',
            optionsForFile: () => ({
              hardenedRuntime: true,
              entitlements: ENTITLEMENTS_PATH,
              signatureFlags: ['runtime'],
            }),
          });
        } else {
          // Local-dev fallback: ad-hoc deep sign so the .app launches
          // (no notarization possible without Developer ID).
          execFileSync(
            'codesign',
            ['--sign', '-', '--force', '--deep', appPath],
            { stdio: 'inherit' },
          );
        }

        if (!isDeveloperId) {
          console.log('[postPackage] skipping notarization (ad-hoc only)');
          continue;
        }
        if (process.env.SKIP_NOTARIZE === '1') {
          console.log('[postPackage] SKIP_NOTARIZE=1 — packaged + signed but not notarized');
          continue;
        }

        // Notarize: zip the app, submit, wait, staple. ditto preserves the
        // bundle structure that notarytool expects.
        const zipPath = path.join(outputPath, 'Cerebro-notarize.zip');
        console.log(`[postPackage] zipping for notarization → ${zipPath}`);
        execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
        console.log('[postPackage] submitting to notarytool (this takes a few minutes)…');
        execFileSync(
          'xcrun',
          [
            'notarytool', 'submit', zipPath,
            '--keychain-profile', NOTARIZE_KEYCHAIN_PROFILE,
            '--wait',
          ],
          { stdio: 'inherit' },
        );
        console.log('[postPackage] stapling notarization ticket to .app');
        execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
        fs.unlinkSync(zipPath);
        console.log('[postPackage] .app signed, notarized, and stapled.');
      }
    },
    // After makers run, sign + notarize + staple any DMGs so Gatekeeper
    // also passes silently when the user double-clicks the downloaded DMG
    // (before they've even copied the app to /Applications).
    async postMake(_forgeConfig, makeResults) {
      const identity = findDeveloperIdIdentity();
      if (!identity) {
        console.log('[postMake] no Developer ID — skipping DMG notarization');
        return makeResults;
      }
      for (const result of makeResults) {
        if (result.platform !== 'darwin') continue;
        for (const artifactPath of result.artifacts) {
          if (!artifactPath.endsWith('.dmg')) continue;
          console.log(`[postMake] signing DMG: ${artifactPath}`);
          execFileSync(
            'codesign',
            ['--sign', identity, '--force', '--timestamp', artifactPath],
            { stdio: 'inherit' },
          );
          console.log('[postMake] submitting DMG to notarytool (a few more minutes)…');
          execFileSync(
            'xcrun',
            [
              'notarytool', 'submit', artifactPath,
              '--keychain-profile', NOTARIZE_KEYCHAIN_PROFILE,
              '--wait',
            ],
            { stdio: 'inherit' },
          );
          console.log('[postMake] stapling notarization ticket to DMG');
          execFileSync('xcrun', ['stapler', 'staple', artifactPath], { stdio: 'inherit' });
        }
      }
      return makeResults;
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerDMG({}),
    new MakerDeb({}),
    new MakerRpm({}),
    new MakerAppImage({ options: { icon: './assets/icon.png' } }),
  ],
  publishers: [
    new PublisherGithub({
      repository: {
        owner: 'AgenticFirst',
        name: 'Cerebro',
      },
      prerelease: false,
      draft: true,
    }),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
