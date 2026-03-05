import { useState, useRef, useEffect, useMemo } from 'react';
import {
  ArrowLeft,
  Play,
  LayoutGrid,
  Trash2,
  Power,
  Hand,
  Clock,
  Webhook,
  Check,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import clsx from 'clsx';
import type { Routine, TriggerType } from '../../../types/routines';
import type { SaveStatus } from '../../../hooks/useRoutineCanvas';
import { useRoutines } from '../../../context/RoutineContext';
import Toggle from '../../ui/Toggle';
import SchedulePicker from '../../ui/SchedulePicker';
import type { DayOfWeek } from '../../../utils/cron-helpers';
import { cronToSchedule, scheduleToCron, describeSchedule, WEEKDAYS } from '../../../utils/cron-helpers';

// ── Helpers ────────────────────────────────────────────────────

const TRIGGER_OPTIONS: { value: TriggerType; label: string; icon: typeof Hand }[] = [
  { value: 'manual', label: 'Manual', icon: Hand },
  { value: 'cron', label: 'Scheduled', icon: Clock },
  { value: 'webhook', label: 'Webhook', icon: Webhook },
];

// ── Component ──────────────────────────────────────────────────

interface EditorToolbarProps {
  routine: Routine;
  isDirty: boolean;
  hasNodes: boolean;
  saveStatus: SaveStatus;
  onSave: () => Promise<void>;
  onAutoLayout: () => void;
}

export default function EditorToolbar({
  routine,
  isDirty,
  hasNodes,
  saveStatus,
  onSave,
  onAutoLayout,
}: EditorToolbarProps) {
  const { setEditingRoutineId, updateRoutine, deleteRoutine, toggleEnabled, runRoutine } =
    useRoutines();

  const [name, setName] = useState(routine.name);
  const [showTriggerMenu, setShowTriggerMenu] = useState(false);
  const [showSchedulePicker, setShowSchedulePicker] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const scheduleRef = useRef<HTMLDivElement>(null);

  // Parse existing cron expression into schedule config
  const existingSchedule = useMemo(
    () => routine.cronExpression ? cronToSchedule(routine.cronExpression) : null,
    [routine.cronExpression],
  );
  const [scheduleDays, setScheduleDays] = useState<DayOfWeek[]>(
    existingSchedule?.days ?? [...WEEKDAYS],
  );
  const [scheduleTime, setScheduleTime] = useState(
    existingSchedule?.time ?? '09:00',
  );

  useEffect(() => {
    setName(routine.name);
  }, [routine.name]);

  // Sync schedule state when routine changes
  useEffect(() => {
    if (routine.cronExpression) {
      const parsed = cronToSchedule(routine.cronExpression);
      if (parsed) {
        setScheduleDays(parsed.days);
        setScheduleTime(parsed.time);
      }
    }
  }, [routine.cronExpression]);

  // Close trigger menu and schedule picker on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
        setShowTriggerMenu(false);
      }
      if (scheduleRef.current && !scheduleRef.current.contains(e.target as Node)) {
        setShowSchedulePicker(false);
      }
    };
    if (showTriggerMenu || showSchedulePicker) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showTriggerMenu, showSchedulePicker]);

  const handleNameBlur = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== routine.name) {
      updateRoutine(routine.id, { name: trimmed });
    } else {
      setName(routine.name);
    }
  };

  const handleTriggerChange = (value: TriggerType) => {
    if (value === 'cron') {
      const cronExpr = scheduleToCron({ days: scheduleDays, time: scheduleTime });
      updateRoutine(routine.id, { trigger_type: value, cron_expression: cronExpr });
      setShowTriggerMenu(false);
      setShowSchedulePicker(true);
    } else {
      updateRoutine(routine.id, { trigger_type: value, cron_expression: null });
      setShowTriggerMenu(false);
      setShowSchedulePicker(false);
    }
  };

  const handleScheduleChange = (days: DayOfWeek[], time: string) => {
    setScheduleDays(days);
    setScheduleTime(time);
    if (days.length > 0) {
      const cronExpr = scheduleToCron({ days, time });
      updateRoutine(routine.id, { cron_expression: cronExpr });
    }
  };

  const currentTrigger =
    TRIGGER_OPTIONS.find((t) => t.value === routine.triggerType) ?? TRIGGER_OPTIONS[0];
  const TriggerIcon = currentTrigger.icon;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-bg-surface border-b border-border-subtle flex-shrink-0 z-20">
      {/* Left: Back + Name */}
      <button
        onClick={() => setEditingRoutineId(null)}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
      >
        <ArrowLeft size={16} />
      </button>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={handleNameBlur}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="text-sm font-medium text-text-primary bg-transparent border-none outline-none hover:bg-bg-hover focus:bg-bg-elevated rounded px-2 py-1 transition-colors min-w-[120px] max-w-[280px]"
      />

      {/* Center: Trigger pill */}
      <div className="relative" ref={triggerRef}>
        <button
          onClick={() => setShowTriggerMenu((prev) => !prev)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-bg-elevated text-text-secondary border border-border-subtle hover:border-border-default transition-colors"
        >
          <TriggerIcon size={11} />
          {currentTrigger.label}
        </button>

        {showTriggerMenu && (
          <div className="absolute top-full left-0 mt-1 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg py-1 min-w-[140px] z-50">
            {TRIGGER_OPTIONS.map((opt) => {
              const OptIcon = opt.icon;
              return (
                <button
                  key={opt.value}
                  onClick={() => handleTriggerChange(opt.value)}
                  className={clsx(
                    'flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors',
                    opt.value === routine.triggerType
                      ? 'text-accent bg-accent/10'
                      : 'text-text-secondary hover:bg-bg-hover',
                  )}
                >
                  <OptIcon size={12} />
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Schedule picker popover */}
      {routine.triggerType === 'cron' && (
        <div className="relative" ref={scheduleRef}>
          <button
            onClick={() => setShowSchedulePicker((prev) => !prev)}
            className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-bg-elevated text-text-tertiary border border-border-subtle hover:border-border-default hover:text-text-secondary transition-colors"
          >
            {existingSchedule
              ? describeSchedule({ days: scheduleDays, time: scheduleTime })
              : 'Set schedule'}
          </button>

          {showSchedulePicker && (
            <div className="absolute top-full left-0 mt-1 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg p-3 min-w-[280px] z-50">
              <SchedulePicker
                days={scheduleDays}
                time={scheduleTime}
                onDaysChange={(days) => handleScheduleChange(days, scheduleTime)}
                onTimeChange={(time) => handleScheduleChange(scheduleDays, time)}
              />
            </div>
          )}
        </div>
      )}

      <div className="flex-1" />

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={onAutoLayout}
          disabled={!hasNodes}
          className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Auto-layout"
        >
          <LayoutGrid size={15} />
        </button>

        <button
          onClick={() => {
            if (window.confirm('Delete this routine?')) {
              deleteRoutine(routine.id);
              setEditingRoutineId(null);
            }
          }}
          className="p-1.5 rounded-md text-text-tertiary hover:text-red-400 hover:bg-red-400/10 transition-colors"
          title="Delete routine"
        >
          <Trash2 size={15} />
        </button>

        <div className="flex items-center gap-1.5">
          <Power
            size={12}
            className={clsx(
              routine.isEnabled ? 'text-green-400' : 'text-text-tertiary',
            )}
          />
          <Toggle
            checked={routine.isEnabled}
            onChange={() => toggleEnabled(routine)}
          />
        </div>

        {/* Autosave status indicator */}
        {saveStatus === 'saving' && (
          <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-text-tertiary">
            <Loader2 size={13} className="animate-spin" />
            Saving...
          </span>
        )}
        {saveStatus === 'saved' && (
          <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-green-400">
            <Check size={13} />
            Saved
          </span>
        )}
        {saveStatus === 'error' && (
          <button
            onClick={onSave}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-red-400 hover:text-red-300 transition-colors"
          >
            <AlertCircle size={13} />
            Save failed — retry
          </button>
        )}
        {saveStatus === 'idle' && isDirty && (
          <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-text-tertiary/60">
            Unsaved
          </span>
        )}

        <button
          onClick={() => runRoutine(routine.id)}
          disabled={!routine.isEnabled || !routine.dagJson || saveStatus === 'saving'}
          title={saveStatus === 'saving' ? 'Saving in progress...' : undefined}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-bg-elevated text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <Play size={13} />
          Run
        </button>
      </div>
    </div>
  );
}
