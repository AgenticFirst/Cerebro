import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Toggle from '../../ui/Toggle';
import { loadSetting, saveSetting } from '../../../lib/settings';

/** Language options — autonym labels so users can always find their language. */
const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Espa\u00f1ol' },
] as const;

export default function AppearanceSection() {
  const { t, i18n } = useTranslation();
  const [showHistoricalLogs, setShowHistoricalLogs] = useState(false);

  useEffect(() => {
    loadSetting<boolean>('show_historical_step_logs').then((v) => {
      if (v != null) setShowHistoricalLogs(v);
    });
  }, []);

  const handleToggle = () => {
    const next = !showHistoricalLogs;
    setShowHistoricalLogs(next);
    saveSetting('show_historical_step_logs', next);
  };

  const handleLanguageChange = (code: string) => {
    i18n.changeLanguage(code);
    saveSetting('ui_language', code);
    try { localStorage.setItem('cerebro_ui_language', code); } catch { /* private browsing */ }
  };

  return (
    <div>
      <h2 className="text-base font-semibold text-text-primary mb-1">{t('appearance.title')}</h2>
      <p className="text-xs text-text-secondary mb-6">{t('appearance.description')}</p>

      {/* Language selector */}
      <div className="flex items-start justify-between gap-4 py-3 border-b border-white/[0.06]">
        <div>
          <p className="text-sm text-text-primary">{t('appearance.language')}</p>
          <p className="text-xs text-text-secondary mt-0.5">
            {t('appearance.languageDesc')}
          </p>
        </div>
        <select
          value={i18n.language}
          onChange={(e) => handleLanguageChange(e.target.value)}
          className="bg-bg-elevated text-text-primary text-sm rounded-md border border-border-subtle px-3 py-1.5 outline-none focus:border-accent cursor-pointer min-w-[140px]"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>

      {/* Historical logs toggle */}
      <div className="flex items-start justify-between gap-4 py-3">
        <div>
          <p className="text-sm text-text-primary">{t('appearance.showHistoricalLogs')}</p>
          <p className="text-xs text-text-secondary mt-0.5">
            {t('appearance.showHistoricalLogsDesc')}
          </p>
        </div>
        <Toggle checked={showHistoricalLogs} onChange={handleToggle} />
      </div>
    </div>
  );
}
