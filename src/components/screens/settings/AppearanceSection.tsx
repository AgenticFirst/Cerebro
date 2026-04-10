import { useState, useEffect } from 'react';
import Toggle from '../../ui/Toggle';
import { loadSetting, saveSetting } from '../../../lib/settings';

export default function AppearanceSection() {
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

  return (
    <div>
      <h2 className="text-base font-semibold text-text-primary mb-1">Appearance</h2>
      <p className="text-xs text-text-secondary mb-6">Customize how Cerebro looks and behaves.</p>

      <div className="flex items-start justify-between gap-4 py-3">
        <div>
          <p className="text-sm text-text-primary">Show historical step logs</p>
          <p className="text-xs text-text-secondary mt-0.5">
            Display step-by-step logs when viewing past routine runs. Logs are always recorded — this controls whether they appear in the UI.
          </p>
        </div>
        <Toggle checked={showHistoricalLogs} onChange={handleToggle} />
      </div>
    </div>
  );
}
