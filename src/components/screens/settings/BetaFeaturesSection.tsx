import { AlertTriangle, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import Toggle from '../../ui/Toggle';
import {
  BETA_FEATURES,
  useFeatureFlags,
  type BetaFeatureKey,
} from '../../../context/FeatureFlagsContext';

const DISCORD_URL = 'https://discord.gg/xFtquA3AC';
const GITHUB_ISSUES_URL = 'https://github.com/AgenticFirst/Cerebro/issues';

function BetaLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs text-amber-100 hover:text-white inline-flex items-center gap-1 underline underline-offset-2 decoration-amber-300/40 hover:decoration-amber-100"
    >
      {children}
      <ExternalLink size={10} />
    </a>
  );
}

export default function BetaFeaturesSection() {
  const { t } = useTranslation();
  const { flags, setFlag } = useFeatureFlags();

  const handleToggle = (key: BetaFeatureKey) => {
    setFlag(key, !flags[key]);
  };

  return (
    <div>
      <h2 className="text-base font-semibold text-text-primary mb-1">
        {t('betaFeatures.title')}
      </h2>
      <p className="text-xs text-text-secondary mb-5">
        {t('betaFeatures.description')}
      </p>

      <div className="px-4 py-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-sm text-amber-200 mb-6">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium">{t('betaFeatures.warningTitle')}</div>
            <div className="text-xs text-amber-200/80 mt-1">
              {t('betaFeatures.warningBody')}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2.5">
              <BetaLink href={DISCORD_URL}>{t('betaFeatures.discordLink')}</BetaLink>
              <BetaLink href={GITHUB_ISSUES_URL}>{t('betaFeatures.githubLink')}</BetaLink>
            </div>
          </div>
        </div>
      </div>

      {BETA_FEATURES.length === 0 ? (
        <p className="text-xs text-text-tertiary text-center py-8">
          {t('betaFeatures.emptyState')}
        </p>
      ) : (
        BETA_FEATURES.map((feature, idx) => (
          <div
            key={feature.key}
            className={clsx(
              'flex items-start justify-between gap-4 py-3',
              idx < BETA_FEATURES.length - 1 && 'border-b border-white/[0.06]',
            )}
          >
            <div>
              <p className="text-sm text-text-primary">{t(feature.labelKey)}</p>
              <p className="text-xs text-text-secondary mt-0.5">
                {t(feature.descriptionKey)}
              </p>
            </div>
            <Toggle
              checked={flags[feature.key]}
              onChange={() => handleToggle(feature.key)}
            />
          </div>
        ))
      )}
    </div>
  );
}
