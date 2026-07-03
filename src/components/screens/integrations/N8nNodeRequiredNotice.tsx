/**
 * "Node.js required" banner shared by the n8n connect modal and the
 * Integrations section card. Sources the minimum version from the same
 * constant the manager enforces, so a future n8n bump updates the UI copy
 * automatically.
 */

import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { N8N_MIN_NODE_MAJOR } from '../../../n8n/types';

export default function N8nNodeRequiredNotice() {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
      <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
      <div>
        {t('n8nSetup.nodeRequiredBody', { version: N8N_MIN_NODE_MAJOR })}{' '}
        <button
          className="underline hover:text-red-300"
          onClick={() => void window.cerebro.shell?.openExternal?.('https://nodejs.org')}
        >
          {t('n8nSetup.nodeRequiredLink')}
        </button>
      </div>
    </div>
  );
}
