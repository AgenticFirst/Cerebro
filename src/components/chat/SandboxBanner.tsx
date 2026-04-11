/**
 * SandboxBanner — opt-in nudge for existing users.
 *
 * Renders above the chat thread when the sandbox is disabled and the user
 * hasn't dismissed the banner. Clicking "Enable sandbox" jumps to Settings →
 * Sandbox; "Dismiss" persists the dismissal via the sandbox config.
 */

import { Shield, X } from 'lucide-react';
import { useSandbox } from '../../context/SandboxContext';
import { useChat } from '../../context/ChatContext';
import { setPendingSettingsSection } from '../screens/settings/pending-section';

export default function SandboxBanner() {
  const { config, dismissBanner } = useSandbox();
  const { setActiveScreen } = useChat();

  if (!config) return null;
  if (config.enabled) return null;
  if (config.banner_dismissed) return null;
  if (!config.platform_supported) return null;

  const handleEnable = () => {
    setPendingSettingsSection('sandbox');
    setActiveScreen('settings');
  };

  return (
    <div className="mx-4 mt-3">
      <div className="mx-auto max-w-3xl flex items-start gap-3 px-4 py-3 rounded-lg border border-accent/30 bg-accent/10">
        <div className="w-8 h-8 rounded-lg bg-accent/20 text-accent flex items-center justify-center flex-shrink-0 mt-0.5">
          <Shield size={15} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary">
            Agents currently have full access to your Mac
          </div>
          <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">
            Turn on the sandbox to confine Cerebro to a workspace and the projects you
            explicitly link. You can enable it in a few seconds.
          </div>
          <div className="flex items-center gap-2 mt-2.5">
            <button
              onClick={handleEnable}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-base hover:bg-accent/90 transition-colors cursor-pointer"
            >
              Enable sandbox
            </button>
            <button
              onClick={() => dismissBanner()}
              className="px-3 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-white/[0.04] transition-colors cursor-pointer"
            >
              Not now
            </button>
          </div>
        </div>
        <button
          onClick={() => dismissBanner()}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-white/[0.04] transition-colors cursor-pointer flex-shrink-0"
          aria-label="Dismiss sandbox banner"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
