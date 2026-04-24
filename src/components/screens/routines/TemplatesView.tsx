import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react';
import { ROUTINE_TEMPLATES } from '../../../routine-templates';
import type { RoutineTemplate, RequiredConnection } from '../../../types/routine-templates';
import type { CreateRoutineInput } from '../../../types/routines';
import { useRoutines } from '../../../context/RoutineContext';
import { WhatsAppIcon, HubSpotIcon, TelegramIcon } from '../../icons/BrandIcons';
import UseTemplateDialog from './UseTemplateDialog';

const INITIAL_CONNECTIONS: Record<string, boolean> = { whatsapp: false, hubspot: false, telegram: false };

const CONNECTION_META: Record<string, { label: string; Icon: (p: { size?: number; className?: string }) => JSX.Element }> = {
  whatsapp: { label: 'WhatsApp', Icon: WhatsAppIcon },
  hubspot: { label: 'HubSpot', Icon: HubSpotIcon },
  telegram: { label: 'Telegram', Icon: TelegramIcon },
};

export default function TemplatesView() {
  const { createRoutine, setEditingRoutineId } = useRoutines();
  const [selected, setSelected] = useState<RoutineTemplate | null>(null);
  const [connectionState, setConnectionState] = useState<Record<string, boolean>>(INITIAL_CONNECTIONS);

  const refreshConnections = useCallback(async () => {
    const [wa, hs, tg] = await Promise.all([
      window.cerebro.whatsapp.status(),
      window.cerebro.hubspot.status(),
      window.cerebro.telegram.status(),
    ]);
    const next = {
      whatsapp: wa.state === 'connected',
      hubspot: hs.hasToken,
      telegram: Boolean(tg.hasToken),
    };
    setConnectionState((prev) =>
      prev.whatsapp === next.whatsapp && prev.hubspot === next.hubspot && prev.telegram === next.telegram
        ? prev
        : next,
    );
  }, []);

  useEffect(() => {
    void refreshConnections();
    // WhatsApp pushes status; Hubspot/Telegram don't, so we keep a coarse poll
    // for those. 10s is plenty for a screen the user only looks at occasionally.
    const off = window.cerebro.whatsapp.onStatusChanged(() => { void refreshConnections(); });
    const id = setInterval(refreshConnections, 10_000);
    return () => { off(); clearInterval(id); };
  }, [refreshConnections]);

  const handleCreate = useCallback(async (input: CreateRoutineInput): Promise<boolean> => {
    const created = await createRoutine(input);
    if (created) {
      setEditingRoutineId(created.id);
      return true;
    }
    return false;
  }, [createRoutine, setEditingRoutineId]);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      <div className="p-6">
        <div className="mb-5">
          <div className="text-sm font-medium text-text-primary">Templates</div>
          <p className="text-xs text-text-tertiary mt-1 leading-relaxed">
            Pre-built routines for common workflows. Pick one, connect the integrations it needs, and customize a few fields.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3">
          {ROUTINE_TEMPLATES.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              connectionState={connectionState}
              onClick={() => setSelected(t)}
            />
          ))}
        </div>
      </div>

      {selected && (
        <UseTemplateDialog
          template={selected}
          onClose={() => setSelected(null)}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}

function TemplateCard({
  template,
  connectionState,
  onClick,
}: {
  template: RoutineTemplate;
  connectionState: Record<string, boolean>;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      className="text-left bg-bg-surface border border-border-subtle rounded-lg p-5 hover:border-accent/40 hover:bg-bg-surface/80 transition-colors cursor-pointer"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-accent/15 text-accent flex items-center justify-center flex-shrink-0">
          <Sparkles size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary">
            {template.name.replace(/%%\w+%%/g, '…')}
          </div>
          <p className="text-xs text-text-secondary mt-1 leading-relaxed">
            {template.description.replace(/%%\w+%%/g, '…')}
          </p>

          {/* Required connections */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {template.requiredConnections.map((c) => (
              <ConnectionChip key={c} id={c} connected={connectionState[c] ?? false} />
            ))}
          </div>

          {/* Plain-English steps preview */}
          <ul className="mt-3 space-y-1 text-[11px] text-text-tertiary leading-relaxed">
            {template.plainEnglishSteps.slice(0, 3).map((s, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="text-accent/60">•</span>
                <span>{s.replace(/%%\w+%%/g, '…')}</span>
              </li>
            ))}
            {template.plainEnglishSteps.length > 3 && (
              <li className="text-text-tertiary/60">+ {template.plainEnglishSteps.length - 3} more…</li>
            )}
          </ul>
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClick(); }}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover flex-shrink-0 flex items-center gap-1.5"
        >
          <Sparkles size={12} />
          Use template
        </button>
      </div>
    </div>
  );
}

function ConnectionChip({ id, connected }: { id: RequiredConnection; connected: boolean }) {
  const m = CONNECTION_META[id] ?? { label: id, Icon: () => <span /> };
  const Icon = m.Icon;
  return (
    <span
      className={clsx(
        'text-[10px] font-medium px-2 py-1 rounded-full border flex items-center gap-1.5',
        connected
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-400',
      )}
    >
      <Icon size={11} />
      {m.label}
      {connected ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
    </span>
  );
}
