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
    asar: true,
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
      const { signAsync } = await import('@electron/osx-sign');

      for (const outputPath of options.outputPaths) {
        const appPath = path.join(outputPath, 'Cerebro.app');
        const plistPath = path.join(appPath, 'Contents', 'Info.plist');

        execFileSync('/usr/libexec/PlistBuddy', [
          '-c',
          'Set :CFBundleDisplayName Cerebro',
          plistPath,
        ]);

        if (isDeveloperId) {
          await signAsync({
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
