import type { Theme } from '@blocknote/mantine';

/**
 * BlockNote themes mapped onto Cerebro's "Neural" design tokens so the editor
 * matches the rest of the app instead of BlockNote's default look. We ship
 * explicit hex values (rather than `var(--color-…)`) so the editor renders
 * correctly regardless of how BlockNote injects its CSS variables — the active
 * theme is chosen at render time from `useTheme().resolvedTheme`.
 *
 * Token sources: src/styles/app.css (@theme dark defaults + .light overrides).
 */

const GEIST = "'Geist Sans', system-ui, -apple-system, sans-serif";

export const kbDarkTheme: Theme = {
  colors: {
    editor: { text: '#fafafa', background: '#09090b' },
    menu: { text: '#fafafa', background: '#1c1c20' },
    tooltip: { text: '#fafafa', background: '#252529' },
    hovered: { text: '#fafafa', background: '#252529' },
    selected: { text: '#ffffff', background: 'rgba(6, 182, 212, 0.25)' },
    disabled: { text: '#71717a', background: '#131316' },
    shadow: 'rgba(0, 0, 0, 0.5)',
    border: '#27272a',
    sideMenu: '#71717a',
  },
  borderRadius: 8,
  fontFamily: GEIST,
};

export const kbLightTheme: Theme = {
  colors: {
    editor: { text: '#1a1a1a', background: '#fbfaf4' },
    menu: { text: '#1a1a1a', background: '#f5f3eb' },
    tooltip: { text: '#1a1a1a', background: '#eeebe0' },
    hovered: { text: '#1a1a1a', background: '#e7e3d4' },
    selected: { text: '#1a1a1a', background: 'rgba(8, 145, 178, 0.18)' },
    disabled: { text: '#7a7a7a', background: '#f5f3eb' },
    shadow: 'rgba(0, 0, 0, 0.12)',
    border: '#d6d2c4',
    sideMenu: '#7a7a7a',
  },
  borderRadius: 8,
  fontFamily: GEIST,
};

export function kbTheme(resolved: 'light' | 'dark'): Theme {
  return resolved === 'dark' ? kbDarkTheme : kbLightTheme;
}
