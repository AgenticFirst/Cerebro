import './i18n';
import i18n from './i18n';
import { createRoot } from 'react-dom/client';
import App from './App';

// Sync language from localStorage (written by AppearanceSection on change).
// This avoids blocking first render on a backend IPC round-trip.
const savedLang = localStorage.getItem('cerebro_ui_language');
if (savedLang && savedLang !== 'en') {
  i18n.changeLanguage(savedLang);
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);
