import i18n from './i18n';
import { createRoot } from 'react-dom/client';
import App from './App';

// Sync language from localStorage (written by AppearanceSection on change).
// This avoids blocking first render on a backend IPC round-trip.
const savedLang = localStorage.getItem('cerebro_ui_language');
if (savedLang && savedLang !== 'en') {
  i18n.changeLanguage(savedLang);
}

// Apply theme class pre-paint to avoid flash-of-wrong-theme. ThemeContext
// syncs state from this same key once React mounts.
const savedTheme = localStorage.getItem('cerebro_ui_theme');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const resolvedTheme =
  savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : prefersDark ? 'dark' : 'light';
document.documentElement.classList.add(resolvedTheme);

const root = createRoot(document.getElementById('root'));
root.render(<App />);
