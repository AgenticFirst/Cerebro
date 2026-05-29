/**
 * CapabilitiesModal — the "Help" panel users open from the chat input.
 *
 * Reads dynamically from three places so new connections, skills, or experts
 * show up automatically without UI changes:
 *   - Integration actions: window.cerebro.chatActions.catalog(lang)
 *     (driven by the engine's chat-exposable action registry)
 *   - Skills: GET /skills (existing backend endpoint)
 *   - Experts: GET /experts?is_enabled=true (existing backend endpoint)
 *
 * Localized via i18n; example phrasings come from i18n too so EN and ES
 * versions can highlight the right idioms.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Wrench, Sparkles, Users, MessageSquare, X } from 'lucide-react';
import clsx from 'clsx';
import type { ChatActionCatalogEntry } from '../../types/ipc';
import type { Skill } from '../../types/skills';

interface CapabilitiesModalProps {
  onClose: () => void;
}

interface ApiExpertLite {
  id: string;
  name: string;
  description: string;
  is_enabled: boolean;
}

const GROUP_TITLES: Record<string, { en: string; es: string }> = {
  hubspot: { en: 'HubSpot', es: 'HubSpot' },
  telegram: { en: 'Telegram', es: 'Telegram' },
  whatsapp: { en: 'WhatsApp', es: 'WhatsApp' },
  http: { en: 'HTTP requests', es: 'Solicitudes HTTP' },
  system: { en: 'System', es: 'Sistema' },
  other: { en: 'Other', es: 'Otros' },
};

export default function CapabilitiesModal({ onClose }: CapabilitiesModalProps) {
  const { t, i18n } = useTranslation();
  const lang: 'en' | 'es' = i18n.language?.startsWith('es') ? 'es' : 'en';

  const [actions, setActions] = useState<ChatActionCatalogEntry[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [experts, setExperts] = useState<ApiExpertLite[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      window.cerebro.chatActions.catalog(lang).catch(() => [] as ChatActionCatalogEntry[]),
      window.cerebro
        .invoke<{ skills: Skill[] }>({ method: 'GET', path: '/skills' })
        .then((res) => (res.ok ? res.data.skills : []))
        .catch(() => []),
      window.cerebro
        .invoke<{ experts: ApiExpertLite[] }>({ method: 'GET', path: '/experts?is_enabled=true&limit=200' })
        .then((res) => (res.ok ? res.data.experts : []))
        .catch(() => []),
    ]).then(([catalog, sk, ex]) => {
      if (cancelled) return;
      setActions(catalog);
      setSkills(sk);
      setExperts(ex);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [lang]);

  // Group actions by their `group` key (hubspot/telegram/whatsapp/http/…).
  const actionsByGroup = actions.reduce<Record<string, ChatActionCatalogEntry[]>>(
    (acc, a) => {
      const key = a.group ?? 'other';
      (acc[key] ||= []).push(a);
      return acc;
    },
    {},
  );

  const examples = (t('capabilitiesModal.examples', { returnObjects: true }) as string[]) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col animate-fade-in">
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3 border-b border-border-subtle">
          <div>
            <h2 className="text-base font-medium text-text-primary">{t('capabilitiesModal.title')}</h2>
            <p className="mt-1 text-xs text-text-secondary leading-relaxed max-w-lg">
              {t('capabilitiesModal.subtitle')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
            aria-label={t('capabilitiesModal.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* ── Integration actions ──────────────────────────── */}
          <section>
            <SectionHeader icon={<Wrench size={13} />} title={t('capabilitiesModal.sections.actions')} />
            {loading ? (
              <SkeletonRows />
            ) : actions.length === 0 ? (
              <EmptyHint text={t('capabilitiesModal.emptyActions')} />
            ) : (
              <div className="space-y-4">
                {Object.entries(actionsByGroup).map(([groupKey, list]) => (
                  <div key={groupKey}>
                    <h4 className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary mb-1.5">
                      {GROUP_TITLES[groupKey]?.[lang] ?? groupKey}
                    </h4>
                    <ul className="space-y-1.5">
                      {list.map((a) => (
                        <ActionRow key={a.type} action={a} lang={lang} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Skills ───────────────────────────────────────── */}
          <section>
            <SectionHeader icon={<Sparkles size={13} />} title={t('capabilitiesModal.sections.skills')} />
            {loading ? (
              <SkeletonRows />
            ) : skills.length === 0 ? (
              <EmptyHint text={t('capabilitiesModal.emptySkills')} />
            ) : (
              <ul className="space-y-1.5">
                {skills.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-md bg-bg-elevated border border-border-subtle px-3 py-2"
                  >
                    <div className="text-xs font-medium text-text-primary">{s.name}</div>
                    <div className="text-[11px] text-text-secondary mt-0.5 line-clamp-2">{s.description}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Experts ──────────────────────────────────────── */}
          <section>
            <SectionHeader icon={<Users size={13} />} title={t('capabilitiesModal.sections.experts')} />
            {loading ? (
              <SkeletonRows />
            ) : experts.length === 0 ? (
              <EmptyHint text={t('capabilitiesModal.emptyExperts')} />
            ) : (
              <ul className="space-y-1.5">
                {experts.map((e) => (
                  <li
                    key={e.id}
                    className="rounded-md bg-bg-elevated border border-border-subtle px-3 py-2"
                  >
                    <div className="text-xs font-medium text-text-primary">{e.name}</div>
                    <div className="text-[11px] text-text-secondary mt-0.5 line-clamp-2">{e.description}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Examples ─────────────────────────────────────── */}
          <section>
            <SectionHeader icon={<MessageSquare size={13} />} title={t('capabilitiesModal.sections.examples')} />
            <p className="text-[11px] text-text-tertiary mb-2">{t('capabilitiesModal.examplesIntro')}</p>
            <ul className="space-y-1">
              {examples.map((ex, idx) => (
                <li
                  key={idx}
                  className="text-xs text-text-secondary bg-bg-elevated/60 border border-border-subtle/60 rounded-md px-3 py-1.5"
                >
                  &ldquo;{ex}&rdquo;
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-2 text-text-secondary">
      <span className="text-text-tertiary">{icon}</span>
      <h3 className="text-xs font-medium uppercase tracking-wider">{title}</h3>
    </div>
  );
}

function ActionRow({ action, lang }: { action: ChatActionCatalogEntry; lang: 'en' | 'es' }) {
  const { t } = useTranslation();
  const connected = action.availability === 'available';

  return (
    <li className="rounded-md bg-bg-elevated border border-border-subtle px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-text-primary">{action.label}</span>
            <AvailabilityBadge connected={connected} action={action} />
          </div>
          <div className="text-[11px] text-text-secondary mt-0.5 leading-relaxed">{action.description}</div>
          {action.examples.length > 0 && (
            <div className="mt-1.5 text-[11px] text-text-tertiary italic">
              {action.examples.slice(0, 2).map((ex, i) => (
                <div key={i}>&ldquo;{ex}&rdquo;</div>
              ))}
            </div>
          )}
        </div>
        {!connected && action.setupHref && (
          <a
            href={`#${action.setupHref}`}
            className="flex-shrink-0 inline-flex items-center gap-1 text-[11px] text-accent hover:text-accent-hover"
          >
            {t('capabilitiesModal.availability.setUp')}
            <ExternalLink size={10} />
          </a>
        )}
      </div>
    </li>
  );
}

function AvailabilityBadge({ connected, action }: { connected: boolean; action: ChatActionCatalogEntry }) {
  const { t } = useTranslation();
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded',
        connected
          ? 'bg-accent/10 text-accent border border-accent/20'
          : 'bg-bg-hover text-text-tertiary border border-border-subtle',
      )}
      title={action.availability}
    >
      <span
        className={clsx(
          'w-1.5 h-1.5 rounded-full',
          connected ? 'bg-accent' : 'bg-text-tertiary',
        )}
      />
      {connected
        ? t('capabilitiesModal.availability.connected')
        : t('capabilitiesModal.availability.notConnected')}
    </span>
  );
}

function SkeletonRows() {
  return (
    <ul className="space-y-1.5">
      {[0, 1, 2].map((i) => (
        <li key={i} className="h-12 rounded-md bg-bg-elevated/50 border border-border-subtle/40 animate-pulse" />
      ))}
    </ul>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="text-xs text-text-tertiary bg-bg-elevated/40 border border-border-subtle/50 border-dashed rounded-md px-3 py-3 leading-relaxed">
      {text}
    </div>
  );
}
