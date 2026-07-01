import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';

/**
 * About pane — shows the running Cerebro version.
 *
 * The version comes straight from Electron's `app.getVersion()` (via the
 * backup IPC channel), which reads the `"version"` field in package.json.
 *
 * IMPORTANT: Always bump `"version"` in package.json on every release so the
 * number shown here stays correct. There is no other source of truth — this
 * pane reflects package.json verbatim.
 */
export default function AboutSection() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    window.cerebro.backup
      .appVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Info size={32} className="text-accent mb-4" />
      <h2 className="text-lg font-semibold text-text-primary">Cerebro</h2>
      <p className="mt-1 text-sm text-text-secondary">
        {version ? t('settings.aboutVersion', { version }) : t('settings.aboutVersionLoading')}
      </p>
    </div>
  );
}
