import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Shield, Info, HelpCircle, AlertCircle, Plus, ChevronDown, Search, Check } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { Node } from '@xyflow/react';
import type { RoutineStepData } from '../../../utils/dag-flow-mapping';
import { ACTION_META, resolveActionType } from '../../../utils/step-defaults';
import {
  getAllOutputs,
  sanitizeVarName,
  uniqueVarName,
} from '../../../utils/action-outputs';
import { useExperts } from '../../../context/ExpertContext';
import { useFiles } from '../../../context/FilesContext';
import {
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  findClaudeModel,
} from '../../../utils/claude-models';
import Toggle from '../../ui/Toggle';
import Tooltip from '../../ui/Tooltip';
import VariablesHelpModal from './VariablesHelpModal';

/** Minimal step descriptor threaded from the editor for tooltip + secondary chip lookup. */
interface SourceStepInfo {
  id: string;
  name: string;
  actionType: string;
}

// ── Helpers ────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-2.5">
        {label}
      </h4>
      {children}
    </div>
  );
}

function FieldLabel({ text, hint }: { text: string; hint?: string }) {
  const { t } = useTranslation();
  return (
    <label className="flex items-center gap-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wide mb-1">
      <span>{text}</span>
      {hint && (
        <Tooltip label={t(`routineTooltips.${hint}`)}>
          <span className="inline-flex items-center cursor-help text-text-tertiary/70 hover:text-text-secondary">
            <Info size={10} />
          </span>
        </Tooltip>
      )}
    </label>
  );
}

const inputCls =
  'w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors';
const textareaCls =
  'w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none';
const selectCls = inputCls;

type P = { params: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void };
type PWithStep = P & {
  step?: RoutineStepData;
  sourceSteps?: SourceStepInfo[];
  onAddMapping?: (mapping: {
    sourceStepId: string;
    sourceField: string;
    targetField: string;
  }) => void;
};

// ── AI Param Forms ────────────────────────────────────────────

/**
 * Chips listing the variables wired into this step from upstream edges.
 * Clicking a chip drops its {{placeholder}} into the last-focused prompt/system
 * textarea so users never have to guess the exact syntax. The `+` menu lets
 * users pull in secondary output fields (confidence, stderr, etc.) that aren't
 * auto-wired on connect.
 */
function VariableChips({
  step,
  onInsert,
  sourceSteps,
  onAddMapping,
}: {
  step?: RoutineStepData;
  onInsert: (token: string) => void;
  sourceSteps?: SourceStepInfo[];
  onAddMapping?: (mapping: {
    sourceStepId: string;
    sourceField: string;
    targetField: string;
  }) => void;
}) {
  const mappings = step?.inputMappings ?? [];
  const stepsById = useMemo(() => {
    const m = new Map<string, SourceStepInfo>();
    for (const s of sourceSteps ?? []) m.set(s.id, s);
    return m;
  }, [sourceSteps]);

  // Build the set of upstream steps this node is already wired from and list
  // any of their non-primary fields that could still be pulled in.
  const secondaryCandidates = useMemo(() => {
    const wiredSourceIds = new Set(mappings.map((m) => m.sourceStepId));
    const candidates: { source: SourceStepInfo; field: string; label: string }[] = [];
    for (const sourceId of wiredSourceIds) {
      const source = stepsById.get(sourceId);
      if (!source) continue;
      const outputs = getAllOutputs(resolveActionType(source.actionType));
      for (const out of outputs) {
        if (out.primary) continue;
        const already = mappings.some(
          (m) => m.sourceStepId === sourceId && m.sourceField === out.field,
        );
        if (already) continue;
        candidates.push({ source, field: out.field, label: out.label });
      }
    }
    return candidates;
  }, [mappings, stepsById]);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  if (mappings.length === 0) {
    return (
      <p className="text-[11px] text-text-tertiary leading-relaxed">
        Nothing connected yet. Drag a line from another step into this one and
        its output will appear here as a chip you can click to insert.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-text-tertiary">
        Click to insert. These come from steps connected into this one.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {mappings.map((m, i) => {
          const token = `{{${m.targetField}}}`;
          const source = stepsById.get(m.sourceStepId);
          const outputs = source
            ? getAllOutputs(resolveActionType(source.actionType))
            : [];
          const fieldLabel =
            outputs.find((o) => o.field === m.sourceField)?.label ?? m.sourceField;
          const tip = source
            ? `${source.name} → ${fieldLabel}`
            : `From ${m.sourceStepId}.${m.sourceField}`;
          return (
            <button
              key={`${m.sourceStepId}-${m.targetField}-${i}`}
              type="button"
              onClick={() => onInsert(token)}
              title={tip}
              className="px-2 py-0.5 rounded-full text-[11px] font-mono border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            >
              {token}
            </button>
          );
        })}
        {secondaryCandidates.length > 0 && onAddMapping && (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              title="Add another field from a connected step"
              aria-label="Add another field"
              className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-border-subtle text-text-tertiary hover:text-accent hover:border-accent/40 transition-colors"
            >
              <Plus size={11} />
            </button>
            {menuOpen && (
              <div className="absolute z-10 top-full left-0 mt-1 min-w-[180px] max-w-[260px] rounded-md border border-border-subtle bg-bg-surface shadow-lg py-1">
                {secondaryCandidates.map((c, i) => {
                  const baseVar = `${sanitizeVarName(c.source.name)}_${sanitizeVarName(c.field) || 'field'}`;
                  const targetField = uniqueVarName(baseVar, mappings, c.source.id);
                  return (
                    <button
                      key={`${c.source.id}-${c.field}-${i}`}
                      type="button"
                      onClick={() => {
                        onAddMapping({
                          sourceStepId: c.source.id,
                          sourceField: c.field,
                          targetField,
                        });
                        setMenuOpen(false);
                      }}
                      className="w-full text-left px-3 py-1.5 text-[11px] text-text-secondary hover:bg-bg-hover transition-colors"
                    >
                      <span className="text-text-primary">{c.source.name}</span>
                      <span className="text-text-tertiary"> → </span>
                      <span>{c.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Label + clickable help icon + chips + tutorial modal, bundled so every
 * templated action shares the same UX (and we don't duplicate the modal-open
 * state between AskAiParams and SendNotificationParams).
 */
function AvailableVariablesSection({
  step,
  onInsert,
  sourceSteps,
  onAddMapping,
}: {
  step?: RoutineStepData;
  onInsert: (token: string) => void;
  sourceSteps?: SourceStepInfo[];
  onAddMapping?: (mapping: {
    sourceStepId: string;
    sourceField: string;
    targetField: string;
  }) => void;
}) {
  const { t } = useTranslation();
  const [showHelp, setShowHelp] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-1 mb-1">
        <label className="text-[10px] font-medium text-text-tertiary uppercase tracking-wide">
          {t('variablesHelp.fieldLabel')}
        </label>
        <Tooltip label={t('variablesHelp.helpButton')}>
          <button
            type="button"
            onClick={() => setShowHelp(true)}
            className="inline-flex items-center cursor-pointer text-text-tertiary/70 hover:text-accent transition-colors"
            aria-label={t('variablesHelp.helpButton')}
          >
            <HelpCircle size={11} />
          </button>
        </Tooltip>
      </div>
      <VariableChips
        step={step}
        onInsert={onInsert}
        sourceSteps={sourceSteps}
        onAddMapping={onAddMapping}
      />
      {showHelp && <VariablesHelpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}

function FieldError({ text }: { text: string }) {
  return (
    <p className="mt-1 flex items-center gap-1 text-[11px] text-red-400">
      <AlertCircle size={10} className="flex-shrink-0" />
      <span>{text}</span>
    </p>
  );
}

/**
 * Claude-model picker shared across every AI step. Reads its options from
 * `CLAUDE_MODELS` so adding a new model is a one-file edit. Unknown saved
 * model IDs (e.g. a model we've since removed from the list) stay selectable
 * as a labeled "custom" entry so the step config doesn't silently flip to
 * the default and lose what the user configured.
 */
function ModelPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const known = findClaudeModel(value);
  const selected = known?.id ?? (value ? '__custom__' : DEFAULT_CLAUDE_MODEL);
  const description =
    known?.description ??
    (value
      ? 'Custom model — not in the built-in list.'
      : 'Balanced speed and quality');
  return (
    <div>
      <FieldLabel text="Model" hint="fieldModel" />
      <select
        value={selected}
        onChange={(e) => {
          if (e.target.value === '__custom__') return;
          onChange(e.target.value);
        }}
        className={selectCls}
      >
        {CLAUDE_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} — {m.description}
          </option>
        ))}
        {!known && value && (
          <option value="__custom__">{value} (custom)</option>
        )}
      </select>
      <p className="mt-1 text-[11px] text-text-tertiary">{description}</p>
    </div>
  );
}

function AskAiParams({ params, onChange, step, sourceSteps, onAddMapping }: PWithStep) {
  const { experts } = useExperts();

  // Local state for the text fields. The parent's `onChange` is debounced
  // (150 ms) so the parent's `params.prompt` doesn't update keystroke-by-
  // keystroke. If we bound the textarea directly to `params.prompt`, any
  // unrelated re-render during typing (context value change, ReactFlow
  // tick, dirty flag flip) would snap the controlled value back to the
  // stale prop and eat characters. Keeping the working value locally
  // makes typing resilient. We still propagate every change upward so
  // the node preview + autosave pick it up after the debounce fires.
  const [prompt, setPrompt] = useState((params.prompt as string) ?? '');
  const [systemPrompt, setSystemPrompt] = useState(
    (params.system_prompt as string) ?? '',
  );
  // `paramsRef` lets the keyword chip inserter read the latest `params`
  // without re-creating `insertAtCursor` every render (which would pull
  // a stale closure through the `onFocus` ref).
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const systemRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<'prompt' | 'system'>('prompt');

  const handlePromptChange = (v: string) => {
    setPrompt(v);
    onChange({ ...paramsRef.current, prompt: v });
  };
  const handleSystemChange = (v: string) => {
    setSystemPrompt(v);
    onChange({ ...paramsRef.current, system_prompt: v });
  };

  const insertAtCursor = (token: string) => {
    const field = lastFocused.current;
    const el = field === 'prompt' ? promptRef.current : systemRef.current;
    if (!el) return;
    const current = field === 'prompt' ? prompt : systemPrompt;
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    if (field === 'prompt') handlePromptChange(next);
    else handleSystemChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const agent = (params.agent as string) ?? 'cerebro';
  const subagentChoices = [
    { slug: 'cerebro', label: 'Cerebro (default)' },
    ...experts
      .filter((e) => e.slug && e.slug !== 'cerebro' && e.isEnabled)
      .map((e) => ({ slug: e.slug as string, label: e.name })),
  ];
  const isCustom = !subagentChoices.some((c) => c.slug === agent);

  const [promptTouched, setPromptTouched] = useState(false);
  const promptEmpty = prompt.trim().length === 0;
  const showPromptError = promptTouched && promptEmpty;

  return (
    <div className="space-y-4">
      <div>
        <FieldLabel text="What should the AI do?" hint="stepPrompt" />
        <textarea
          ref={promptRef}
          value={prompt}
          onChange={(e) => handlePromptChange(e.target.value)}
          onFocus={() => { lastFocused.current = 'prompt'; }}
          onBlur={() => setPromptTouched(true)}
          rows={5}
          placeholder="e.g. Summarize the email below in two sentences."
          aria-invalid={showPromptError}
          className={clsx(textareaCls, showPromptError && 'border-red-500/60 focus:border-red-500/60')}
        />
        {showPromptError ? (
          <FieldError text="Required — the step will fail without a prompt." />
        ) : (
          <p className="mt-1 text-[11px] text-text-tertiary">
            Write the instruction in plain English. If you&rsquo;ve connected
            another step, click its chip below to pull its output in.
          </p>
        )}
      </div>

      <AvailableVariablesSection
        step={step}
        onInsert={insertAtCursor}
        sourceSteps={sourceSteps}
        onAddMapping={onAddMapping}
      />

      <div>
        <FieldLabel text="Role / style (optional)" hint="fieldSystemPrompt" />
        <textarea
          ref={systemRef}
          value={systemPrompt}
          onChange={(e) => handleSystemChange(e.target.value)}
          onFocus={() => { lastFocused.current = 'system'; }}
          rows={3}
          placeholder="e.g. You are a terse analyst. Reply with bullet points only."
          className={textareaCls}
        />
        <p className="mt-1 text-[11px] text-text-tertiary">
          Sets the AI&rsquo;s role or tone. Leave empty to use the subagent&rsquo;s
          default behavior.
        </p>
      </div>

      <div>
        <FieldLabel text="Run as" hint="fieldAgent" />
        <select
          value={isCustom ? '__custom__' : agent}
          onChange={(e) => {
            if (e.target.value === '__custom__') return;
            onChange({ ...paramsRef.current, agent: e.target.value });
          }}
          className={selectCls}
        >
          {subagentChoices.map((c) => (
            <option key={c.slug} value={c.slug}>{c.label}</option>
          ))}
          {isCustom && <option value="__custom__">{agent} (custom)</option>}
        </select>
        <p className="mt-1 text-[11px] text-text-tertiary">
          Which Claude Code subagent runs this step. &ldquo;Cerebro&rdquo; is the
          default generalist; pick an expert to use its own system prompt and tools.
        </p>
      </div>

      <ModelPicker
        value={(params.model as string) ?? DEFAULT_CLAUDE_MODEL}
        onChange={(id) => onChange({ ...paramsRef.current, model: id })}
      />
    </div>
  );
}

interface ExpertChoice {
  id: string;
  name: string;
  domain: string | null;
  isEnabled: boolean;
  type: 'expert' | 'team';
}

/**
 * Searchable expert dropdown. Native <select> doesn't expose a search field,
 * so we roll a combobox: a button that opens a panel with a live-filtered
 * input + option list. Keyboard: Arrow keys move the highlight, Enter picks,
 * Escape closes.
 */
function ExpertPicker({
  value,
  choices,
  invalid,
  onChange,
  onBlur,
}: {
  value: string;
  choices: ExpertChoice[];
  invalid?: boolean;
  onChange: (id: string) => void;
  onBlur?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);

  const selected = choices.find((c) => c.id === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return choices;
    return choices.filter((c) => {
      const hay = `${c.name} ${c.domain ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [choices, query]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as HTMLElement)) {
        setOpen(false);
        onBlur?.();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onBlur]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery('');
    onBlur?.();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filtered[highlight];
      if (target) pick(target.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      onBlur?.();
    }
  };

  const renderLabel = (c: ExpertChoice) => {
    const tags = [
      c.domain,
      c.type === 'team' ? 'team' : null,
      !c.isEnabled ? 'disabled' : null,
    ].filter(Boolean);
    return (
      <>
        <span className="text-text-primary">{c.name}</span>
        {tags.length > 0 && (
          <span className="text-text-tertiary"> — {tags.join(' · ')}</span>
        )}
      </>
    );
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-invalid={invalid}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={clsx(
          'w-full flex items-center justify-between gap-2 bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-left focus:outline-none focus:border-accent/30 transition-colors',
          invalid && 'border-red-500/60 focus:border-red-500/60',
        )}
      >
        <span className={clsx('truncate', !selected && 'text-text-tertiary')}>
          {selected ? (
            renderLabel(selected)
          ) : choices.length === 0 ? (
            'No experts yet — create one on the Experts screen'
          ) : (
            'Pick an expert…'
          )}
        </span>
        <ChevronDown
          size={14}
          className={clsx(
            'flex-shrink-0 text-text-tertiary transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 left-0 right-0 rounded-lg border border-border-subtle bg-bg-surface shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border-subtle px-2.5 py-1.5">
            <Search size={12} className="text-text-tertiary flex-shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search experts…"
              className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none"
            />
          </div>
          <div
            ref={optionsRef}
            role="listbox"
            className="max-h-[220px] overflow-y-auto scrollbar-thin py-1"
          >
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-text-tertiary">
                {choices.length === 0
                  ? 'No experts available. Create one on the Experts screen.'
                  : 'No matches.'}
              </div>
            ) : (
              filtered.map((c, i) => {
                const isSel = c.id === value;
                const isHi = i === highlight;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => pick(c.id)}
                    className={clsx(
                      'w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors',
                      isHi ? 'bg-bg-hover' : '',
                    )}
                  >
                    <Check
                      size={12}
                      className={clsx(
                        'flex-shrink-0',
                        isSel ? 'text-accent' : 'text-transparent',
                      )}
                    />
                    <span className="truncate">{renderLabel(c)}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RunExpertParams({ params, onChange, step, sourceSteps, onAddMapping }: PWithStep) {
  const { experts } = useExperts();

  // Local state mirrors the Ask AI pattern — keeps typing smooth against
  // the parent's debounced onChange. Legacy routines may still have the old
  // { task, context, expert_id, max_turns } keys; read them as fallbacks so
  // saved configs don't appear blank after the param rename, but only write
  // the new canonical keys back (matches what the engine action reads).
  const [prompt, setPrompt] = useState(
    (params.prompt as string) ?? (params.task as string) ?? '',
  );
  const [additionalContext, setAdditionalContext] = useState(
    (params.additionalContext as string) ?? (params.context as string) ?? '',
  );
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const contextRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<'prompt' | 'context'>('prompt');

  const handlePromptChange = (v: string) => {
    setPrompt(v);
    onChange({ ...paramsRef.current, prompt: v });
  };
  const handleContextChange = (v: string) => {
    setAdditionalContext(v);
    onChange({ ...paramsRef.current, additionalContext: v });
  };

  const insertAtCursor = (token: string) => {
    const field = lastFocused.current;
    const el = field === 'prompt' ? promptRef.current : contextRef.current;
    if (!el) return;
    const current = field === 'prompt' ? prompt : additionalContext;
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    if (field === 'prompt') handlePromptChange(next);
    else handleContextChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const expertId =
    (params.expertId as string) ?? (params.expert_id as string) ?? '';
  // Show every expert the context surfaces (ExpertContext already hides
  // teams when the feature flag is off) so users never stare at an empty
  // dropdown. Disabled experts stay visible with a tag — the user may be
  // picking one they intend to re-enable.
  const expertChoices = experts.map((e) => ({
    id: e.id,
    name: e.name,
    domain: e.domain,
    isEnabled: e.isEnabled,
    type: e.type,
  }));
  const expertPresent = expertChoices.some((c) => c.id === expertId);

  const maxTurns =
    (params.maxTurns as number) ?? (params.max_turns as number) ?? 10;

  const [promptTouched, setPromptTouched] = useState(false);
  const promptEmpty = prompt.trim().length === 0;
  const showPromptError = promptTouched && promptEmpty;

  const [expertTouched, setExpertTouched] = useState(false);
  const showExpertError = expertTouched && !expertId;

  return (
    <div className="space-y-4">
      <div>
        <FieldLabel text="Which expert?" hint="fieldExpertId" />
        <ExpertPicker
          value={expertId}
          choices={
            expertId && !expertPresent
              ? [
                  ...expertChoices,
                  {
                    id: expertId,
                    name: `${expertId} (unavailable)`,
                    domain: null,
                    isEnabled: false,
                    type: 'expert' as const,
                  },
                ]
              : expertChoices
          }
          invalid={showExpertError}
          onChange={(id) =>
            onChange({ ...paramsRef.current, expertId: id })
          }
          onBlur={() => setExpertTouched(true)}
        />
        {showExpertError ? (
          <FieldError text="Required — pick an expert so this step knows who should run." />
        ) : (
          <p className="mt-1 text-[11px] text-text-tertiary">
            Type to search. Manage experts on the Experts screen.
          </p>
        )}
      </div>

      <div>
        <FieldLabel text="What should the expert do?" hint="stepTask" />
        <textarea
          ref={promptRef}
          value={prompt}
          onChange={(e) => handlePromptChange(e.target.value)}
          onFocus={() => {
            lastFocused.current = 'prompt';
          }}
          onBlur={() => setPromptTouched(true)}
          rows={5}
          placeholder="e.g. Draft a reply to the email below, keeping the tone friendly."
          aria-invalid={showPromptError}
          className={clsx(
            textareaCls,
            showPromptError && 'border-red-500/60 focus:border-red-500/60',
          )}
        />
        {showPromptError ? (
          <FieldError text="Required — the expert needs a task description." />
        ) : (
          <p className="mt-1 text-[11px] text-text-tertiary">
            Describe the task in plain English. If you&rsquo;ve connected
            another step, click its chip below to pull its output in.
          </p>
        )}
      </div>

      <AvailableVariablesSection
        step={step}
        onInsert={insertAtCursor}
        sourceSteps={sourceSteps}
        onAddMapping={onAddMapping}
      />

      <div>
        <FieldLabel text="Extra context (optional)" hint="fieldContext" />
        <textarea
          ref={contextRef}
          value={additionalContext}
          onChange={(e) => handleContextChange(e.target.value)}
          onFocus={() => {
            lastFocused.current = 'context';
          }}
          rows={3}
          placeholder="e.g. Keep replies under 80 words and sign off with 'Thanks'."
          className={textareaCls}
        />
        <p className="mt-1 text-[11px] text-text-tertiary">
          Background prepended to the task. Good for tone, constraints, or
          reference material the expert should keep in mind.
        </p>
      </div>

      <div>
        <FieldLabel text="Max turns" hint="fieldMaxTurns" />
        <input
          type="number"
          min={1}
          max={100}
          value={maxTurns}
          onChange={(e) =>
            onChange({
              ...paramsRef.current,
              maxTurns: parseInt(e.target.value) || 10,
            })
          }
          className={inputCls}
        />
        <p className="mt-1 text-[11px] text-text-tertiary">
          How many reasoning + tool-use rounds the expert gets before stopping.
          Higher is more thorough but slower and more expensive.
        </p>
      </div>

      <ModelPicker
        value={(params.model as string) ?? DEFAULT_CLAUDE_MODEL}
        onChange={(id) => onChange({ ...paramsRef.current, model: id })}
      />
    </div>
  );
}

interface CategoryItem {
  id: string;
  label: string;
  description: string;
}

function ClassifyParams({ params, onChange, step, sourceSteps, onAddMapping }: PWithStep) {
  const { experts } = useExperts();

  // Local state for the prompt keeps typing resilient against the parent's
  // debounced onChange (same pattern as AskAiParams / RunExpertParams).
  const [prompt, setPrompt] = useState((params.prompt as string) ?? '');
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const promptRef = useRef<HTMLTextAreaElement>(null);

  const handlePromptChange = (v: string) => {
    setPrompt(v);
    onChange({ ...paramsRef.current, prompt: v });
  };

  const insertAtCursor = (token: string) => {
    const el = promptRef.current;
    if (!el) return;
    const start = el.selectionStart ?? prompt.length;
    const end = el.selectionEnd ?? prompt.length;
    const next = prompt.slice(0, start) + token + prompt.slice(end);
    handlePromptChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // Categories are persisted on params — no local state. Edits here aren't
  // free-text typing so the debounce-eats-keystrokes risk doesn't apply.
  const rawCategories =
    (params.categories as Array<Partial<CategoryItem>> | undefined) ?? [];
  const categories: CategoryItem[] = rawCategories.map((c, i) => ({
    id: c.id ?? `cat-${i}`,
    label: c.label ?? '',
    description: c.description ?? '',
  }));

  const writeCategories = (next: CategoryItem[]) =>
    onChange({ ...paramsRef.current, categories: next });

  const updateCategory = (index: number, field: 'label' | 'description', value: string) => {
    const updated = categories.map((c, i) => (i === index ? { ...c, [field]: value } : c));
    writeCategories(updated);
  };

  const addCategory = () => {
    writeCategories([
      ...categories,
      { id: crypto.randomUUID(), label: '', description: '' },
    ]);
  };

  const removeCategory = (index: number) => {
    writeCategories(categories.filter((_, i) => i !== index));
  };

  const agent = (params.agent as string) ?? 'cerebro';
  const subagentChoices = [
    { slug: 'cerebro', label: 'Cerebro (default)' },
    ...experts
      .filter((e) => e.slug && e.slug !== 'cerebro' && e.isEnabled)
      .map((e) => ({ slug: e.slug as string, label: e.name })),
  ];
  const isCustom = !subagentChoices.some((c) => c.slug === agent);

  const [promptTouched, setPromptTouched] = useState(false);
  const promptEmpty = prompt.trim().length === 0;
  const showPromptError = promptTouched && promptEmpty;

  const [categoriesTouched, setCategoriesTouched] = useState(false);
  const hasAnyCategory = categories.length > 0;
  const hasBlankLabel = categories.some((c) => c.label.trim().length === 0);
  const showCategoriesError =
    categoriesTouched && (!hasAnyCategory || hasBlankLabel);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-text-secondary">
          Sorts text into one of the categories you define. The AI reads the
          input, picks the best fit, and returns the category label along with
          a confidence rating and short reasoning.
        </p>
      </div>

      <div>
        <FieldLabel text="What should we classify?" hint="fieldInput" />
        <textarea
          ref={promptRef}
          value={prompt}
          onChange={(e) => handlePromptChange(e.target.value)}
          onBlur={() => setPromptTouched(true)}
          rows={5}
          placeholder="e.g. Sort this email by urgency:"
          aria-invalid={showPromptError}
          className={clsx(
            textareaCls,
            showPromptError && 'border-red-500/60 focus:border-red-500/60',
          )}
        />
        {showPromptError ? (
          <FieldError text="Required — the step needs some text to classify." />
        ) : (
          <p className="mt-1 text-[11px] text-text-tertiary">
            The text the AI will classify. Usually a short instruction plus the
            content from a connected step — click a chip below to insert it.
          </p>
        )}
      </div>

      <AvailableVariablesSection
        step={step}
        onInsert={insertAtCursor}
        sourceSteps={sourceSteps}
        onAddMapping={onAddMapping}
      />

      <div>
        <FieldLabel text="Categories" hint="stepCategories" />
        {categories.length === 0 ? (
          <div
            className={clsx(
              'rounded-lg border border-dashed px-3 py-3 text-center',
              showCategoriesError
                ? 'border-red-500/60 bg-red-500/5'
                : 'border-border-subtle bg-bg-base/40',
            )}
          >
            <p className="text-[11px] text-text-tertiary mb-2">
              Add at least one category the AI can choose from.
            </p>
            <button
              type="button"
              onClick={addCategory}
              className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/20 transition-colors"
            >
              <Plus size={11} /> Add first category
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {categories.map((cat, i) => {
              const labelMissing =
                categoriesTouched && cat.label.trim().length === 0;
              return (
                <div
                  key={cat.id}
                  className="rounded-lg border border-border-subtle bg-bg-base/40 p-2 space-y-1.5"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 space-y-1.5">
                      <input
                        value={cat.label}
                        onChange={(e) => updateCategory(i, 'label', e.target.value)}
                        onBlur={() => setCategoriesTouched(true)}
                        placeholder="Category name (e.g. urgent)"
                        aria-invalid={labelMissing}
                        className={clsx(
                          inputCls,
                          labelMissing && 'border-red-500/60 focus:border-red-500/60',
                        )}
                      />
                      <input
                        value={cat.description}
                        onChange={(e) => updateCategory(i, 'description', e.target.value)}
                        placeholder="When to pick this (optional but helps accuracy)"
                        className={inputCls}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeCategory(i)}
                      aria-label="Remove category"
                      title="Remove category"
                      className="mt-1 p-1 text-text-tertiary hover:text-red-400 transition-colors"
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {labelMissing && (
                    <FieldError text="Each category needs a name." />
                  )}
                </div>
              );
            })}
            <button
              type="button"
              onClick={addCategory}
              className="inline-flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors"
            >
              <Plus size={11} /> Add another category
            </button>
          </div>
        )}
        {showCategoriesError && !hasAnyCategory ? (
          <FieldError text="Required — add at least one category." />
        ) : (
          categories.length > 0 && (
            <p className="mt-1 text-[11px] text-text-tertiary">
              The AI must pick exactly one. Clear, non-overlapping names work
              best. Descriptions are optional but sharpen the choice when two
              categories are close.
            </p>
          )
        )}
      </div>

      <div>
        <FieldLabel text="Run as" hint="fieldAgent" />
        <select
          value={isCustom ? '__custom__' : agent}
          onChange={(e) => {
            if (e.target.value === '__custom__') return;
            onChange({ ...paramsRef.current, agent: e.target.value });
          }}
          className={selectCls}
        >
          {subagentChoices.map((c) => (
            <option key={c.slug} value={c.slug}>{c.label}</option>
          ))}
          {isCustom && <option value="__custom__">{agent} (custom)</option>}
        </select>
        <p className="mt-1 text-[11px] text-text-tertiary">
          Which Claude Code subagent does the classification. &ldquo;Cerebro&rdquo;
          is the default; switch to an expert to use its own system prompt.
        </p>
      </div>

      <ModelPicker
        value={(params.model as string) ?? DEFAULT_CLAUDE_MODEL}
        onChange={(id) => onChange({ ...paramsRef.current, model: id })}
      />
    </div>
  );
}

interface SchemaField {
  id: string;
  name: string;
  type: string;
  description: string;
}

const SCHEMA_FIELD_TYPES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'string', label: 'Text', hint: 'Any text — names, sentences, notes.' },
  { value: 'number', label: 'Number', hint: 'Digits — counts, amounts, scores.' },
  { value: 'boolean', label: 'Yes / No', hint: 'True or false.' },
  { value: 'date', label: 'Date', hint: 'A calendar date or timestamp.' },
  { value: 'array', label: 'List', hint: 'Multiple values (e.g. tags).' },
];

function ExtractParams({ params, onChange, step, sourceSteps, onAddMapping }: PWithStep) {
  const { experts } = useExperts();

  const [prompt, setPrompt] = useState((params.prompt as string) ?? '');
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const promptRef = useRef<HTMLTextAreaElement>(null);

  const handlePromptChange = (v: string) => {
    setPrompt(v);
    onChange({ ...paramsRef.current, prompt: v });
  };

  const insertAtCursor = (token: string) => {
    const el = promptRef.current;
    if (!el) return;
    const start = el.selectionStart ?? prompt.length;
    const end = el.selectionEnd ?? prompt.length;
    const next = prompt.slice(0, start) + token + prompt.slice(end);
    handlePromptChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const rawSchema =
    (params.schema as Array<Partial<SchemaField>> | undefined) ?? [];
  const schema: SchemaField[] = rawSchema.map((f, i) => ({
    id: f.id ?? `field-${i}`,
    name: f.name ?? '',
    type: f.type ?? 'string',
    description: f.description ?? '',
  }));

  const writeSchema = (next: SchemaField[]) =>
    onChange({ ...paramsRef.current, schema: next });

  const updateField = (index: number, field: 'name' | 'type' | 'description', value: string) => {
    const updated = schema.map((f, i) => (i === index ? { ...f, [field]: value } : f));
    writeSchema(updated);
  };

  const addField = () => {
    writeSchema([
      ...schema,
      { id: crypto.randomUUID(), name: '', type: 'string', description: '' },
    ]);
  };

  const removeField = (index: number) => {
    writeSchema(schema.filter((_, i) => i !== index));
  };

  const agent = (params.agent as string) ?? 'cerebro';
  const subagentChoices = [
    { slug: 'cerebro', label: 'Cerebro (default)' },
    ...experts
      .filter((e) => e.slug && e.slug !== 'cerebro' && e.isEnabled)
      .map((e) => ({ slug: e.slug as string, label: e.name })),
  ];
  const isCustom = !subagentChoices.some((c) => c.slug === agent);

  const [promptTouched, setPromptTouched] = useState(false);
  const promptEmpty = prompt.trim().length === 0;
  const showPromptError = promptTouched && promptEmpty;

  const [schemaTouched, setSchemaTouched] = useState(false);
  const hasAnyField = schema.length > 0;
  const hasBlankName = schema.some((f) => f.name.trim().length === 0);
  const showSchemaError = schemaTouched && (!hasAnyField || hasBlankName);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-text-secondary">
          Pulls structured fields out of messy text. You describe what to find;
          the AI returns a tidy object with each field filled in (or null when
          the text doesn&rsquo;t mention it).
        </p>
      </div>

      <div>
        <FieldLabel text="What should we extract from?" hint="fieldInput" />
        <textarea
          ref={promptRef}
          value={prompt}
          onChange={(e) => handlePromptChange(e.target.value)}
          onBlur={() => setPromptTouched(true)}
          rows={5}
          placeholder="e.g. Extract contact info from this email:"
          aria-invalid={showPromptError}
          className={clsx(
            textareaCls,
            showPromptError && 'border-red-500/60 focus:border-red-500/60',
          )}
        />
        {showPromptError ? (
          <FieldError text="Required — the step needs some text to pull fields from." />
        ) : (
          <p className="mt-1 text-[11px] text-text-tertiary">
            The text to read. Usually a short instruction plus content from a
            connected step — click a chip below to insert it.
          </p>
        )}
      </div>

      <AvailableVariablesSection
        step={step}
        onInsert={insertAtCursor}
        sourceSteps={sourceSteps}
        onAddMapping={onAddMapping}
      />

      <div>
        <FieldLabel text="Fields to extract" hint="stepSchema" />
        {schema.length === 0 ? (
          <div
            className={clsx(
              'rounded-lg border border-dashed px-3 py-3 text-center',
              showSchemaError
                ? 'border-red-500/60 bg-red-500/5'
                : 'border-border-subtle bg-bg-base/40',
            )}
          >
            <p className="text-[11px] text-text-tertiary mb-2">
              Add at least one field the AI should pull out of the text.
            </p>
            <button
              type="button"
              onClick={addField}
              className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/20 transition-colors"
            >
              <Plus size={11} /> Add first field
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {schema.map((field, i) => {
              const nameMissing =
                schemaTouched && field.name.trim().length === 0;
              return (
                <div
                  key={field.id}
                  className="rounded-lg border border-border-subtle bg-bg-base/40 p-2 space-y-1.5"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 space-y-1.5">
                      <div className="flex gap-1.5">
                        <input
                          value={field.name}
                          onChange={(e) => updateField(i, 'name', e.target.value)}
                          onBlur={() => setSchemaTouched(true)}
                          placeholder="Field name (e.g. email_address)"
                          aria-invalid={nameMissing}
                          className={clsx(
                            inputCls,
                            'flex-1',
                            nameMissing && 'border-red-500/60 focus:border-red-500/60',
                          )}
                        />
                        <select
                          value={field.type}
                          onChange={(e) => updateField(i, 'type', e.target.value)}
                          className={clsx(selectCls, 'w-28 flex-shrink-0')}
                        >
                          {SCHEMA_FIELD_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                          ))}
                        </select>
                      </div>
                      <input
                        value={field.description}
                        onChange={(e) => updateField(i, 'description', e.target.value)}
                        placeholder="What to look for (optional but improves accuracy)"
                        className={inputCls}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeField(i)}
                      aria-label="Remove field"
                      title="Remove field"
                      className="mt-1 p-1 text-text-tertiary hover:text-red-400 transition-colors"
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {nameMissing && (
                    <FieldError text="Each field needs a name." />
                  )}
                </div>
              );
            })}
            <button
              type="button"
              onClick={addField}
              className="inline-flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors"
            >
              <Plus size={11} /> Add another field
            </button>
          </div>
        )}
        {showSchemaError && !hasAnyField ? (
          <FieldError text="Required — add at least one field." />
        ) : (
          schema.length > 0 && (
            <p className="mt-1 text-[11px] text-text-tertiary">
              Use short snake_case names (e.g. <code>due_date</code>). Fields
              the AI can&rsquo;t find come back as <code>null</code>.
            </p>
          )
        )}
      </div>

      <div>
        <FieldLabel text="Run as" hint="fieldAgent" />
        <select
          value={isCustom ? '__custom__' : agent}
          onChange={(e) => {
            if (e.target.value === '__custom__') return;
            onChange({ ...paramsRef.current, agent: e.target.value });
          }}
          className={selectCls}
        >
          {subagentChoices.map((c) => (
            <option key={c.slug} value={c.slug}>{c.label}</option>
          ))}
          {isCustom && <option value="__custom__">{agent} (custom)</option>}
        </select>
        <p className="mt-1 text-[11px] text-text-tertiary">
          Which Claude Code subagent does the extraction. &ldquo;Cerebro&rdquo;
          is the default; switch to an expert to use its own system prompt.
        </p>
      </div>

      <ModelPicker
        value={(params.model as string) ?? DEFAULT_CLAUDE_MODEL}
        onChange={(id) => onChange({ ...paramsRef.current, model: id })}
      />
    </div>
  );
}

const SUMMARIZE_LENGTHS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'short', label: 'Short', hint: '1–2 sentences' },
  { value: 'medium', label: 'Medium', hint: 'one paragraph' },
  { value: 'long', label: 'Long', hint: 'detailed, multi-paragraph' },
];

function SummarizeParams({ params, onChange, step, sourceSteps }: PWithStep) {
  const { experts } = useExperts();

  const paramsRef = useRef(params);
  paramsRef.current = params;

  const mappings = step?.inputMappings ?? [];
  const stepsById = useMemo(() => {
    const m = new Map<string, SourceStepInfo>();
    for (const s of sourceSteps ?? []) m.set(s.id, s);
    return m;
  }, [sourceSteps]);

  const inputField = (params.input_field as string) ?? '';
  const maxLength = (params.max_length as string) ?? 'medium';
  const focus = (params.focus as string) ?? '';
  const agent = (params.agent as string) ?? 'cerebro';

  const subagentChoices = [
    { slug: 'cerebro', label: 'Cerebro (default)' },
    ...experts
      .filter((e) => e.slug && e.slug !== 'cerebro' && e.isEnabled)
      .map((e) => ({ slug: e.slug as string, label: e.name })),
  ];
  const isCustom = !subagentChoices.some((c) => c.slug === agent);

  const [inputTouched, setInputTouched] = useState(false);
  const hasMappings = mappings.length > 0;
  const inputEmpty = inputField.trim().length === 0;
  const showInputError = inputTouched && inputEmpty;

  // When the user picks the only connected source, skip the "touched" gate —
  // the error won't matter because the field is now filled.
  const handleInputChange = (value: string) => {
    onChange({ ...paramsRef.current, input_field: value });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-text-secondary">
          Shortens text from a connected step. Pick which variable to read and
          how long the summary should be.
        </p>
      </div>

      <div>
        <FieldLabel text="What should we summarize?" hint="fieldInputField" />
        {!hasMappings ? (
          <div className="rounded-lg border border-dashed border-border-subtle bg-bg-base/40 px-3 py-3 text-center">
            <p className="text-[11px] text-text-tertiary">
              Connect another step into this one first. Its output will appear
              here as a variable you can pick.
            </p>
          </div>
        ) : (
          <select
            value={inputField}
            onChange={(e) => handleInputChange(e.target.value)}
            onBlur={() => setInputTouched(true)}
            aria-invalid={showInputError}
            className={clsx(
              selectCls,
              showInputError && 'border-red-500/60 focus:border-red-500/60',
            )}
          >
            <option value="">Pick a source…</option>
            {mappings.map((m) => {
              const source = stepsById.get(m.sourceStepId);
              const outputs = source
                ? getAllOutputs(resolveActionType(source.actionType))
                : [];
              const fieldLabel =
                outputs.find((o) => o.field === m.sourceField)?.label ?? m.sourceField;
              const suffix = source ? ` — from ${source.name} · ${fieldLabel}` : '';
              return (
                <option key={m.targetField} value={m.targetField}>
                  {m.targetField}{suffix}
                </option>
              );
            })}
          </select>
        )}
        {showInputError ? (
          <FieldError text="Required — pick which variable to summarize." />
        ) : hasMappings ? (
          <p className="mt-1 text-[11px] text-text-tertiary">
            Variables come from steps connected into this one. Each is the
            output field that upstream step produced.
          </p>
        ) : null}
      </div>

      <div>
        <FieldLabel text="Length" hint="fieldLength" />
        <div className="grid grid-cols-3 gap-1.5">
          {SUMMARIZE_LENGTHS.map((opt) => {
            const active = opt.value === maxLength;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange({ ...paramsRef.current, max_length: opt.value })}
                aria-pressed={active}
                className={clsx(
                  'rounded-lg border px-2 py-2 text-center transition-colors',
                  active
                    ? 'border-accent/50 bg-accent/10 text-accent'
                    : 'border-border-subtle bg-bg-base text-text-secondary hover:border-accent/30',
                )}
              >
                <div className="text-[11px] font-medium">{opt.label}</div>
                <div className="text-[10px] text-text-tertiary">{opt.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <FieldLabel text="Focus (optional)" hint="fieldFocus" />
        <input
          value={focus}
          onChange={(e) => onChange({ ...paramsRef.current, focus: e.target.value })}
          placeholder="e.g. action items, customer concerns, key numbers"
          className={inputCls}
        />
        <p className="mt-1 text-[11px] text-text-tertiary">
          Nudges the AI to emphasize certain aspects. Leave empty for a
          balanced overall summary.
        </p>
      </div>

      <div>
        <FieldLabel text="Run as" hint="fieldAgent" />
        <select
          value={isCustom ? '__custom__' : agent}
          onChange={(e) => {
            if (e.target.value === '__custom__') return;
            onChange({ ...paramsRef.current, agent: e.target.value });
          }}
          className={selectCls}
        >
          {subagentChoices.map((c) => (
            <option key={c.slug} value={c.slug}>{c.label}</option>
          ))}
          {isCustom && <option value="__custom__">{agent} (custom)</option>}
        </select>
        <p className="mt-1 text-[11px] text-text-tertiary">
          Which Claude Code subagent writes the summary. &ldquo;Cerebro&rdquo;
          is the default; switch to an expert to use its own system prompt.
        </p>
      </div>

      <ModelPicker
        value={(params.model as string) ?? DEFAULT_CLAUDE_MODEL}
        onChange={(id) => onChange({ ...paramsRef.current, model: id })}
      />
    </div>
  );
}

// ── Knowledge Param Forms ─────────────────────────────────────

function SearchMemoryParams({ params, onChange, step, sourceSteps, onAddMapping }: PWithStep) {
  const { experts } = useExperts();

  const [query, setQuery] = useState((params.query as string) ?? '');
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const queryRef = useRef<HTMLTextAreaElement>(null);

  const handleQueryChange = (v: string) => {
    setQuery(v);
    onChange({ ...paramsRef.current, query: v });
  };

  const insertAtCursor = (token: string) => {
    const el = queryRef.current;
    if (!el) return;
    const start = el.selectionStart ?? query.length;
    const end = el.selectionEnd ?? query.length;
    const next = query.slice(0, start) + token + query.slice(end);
    handleQueryChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const agent = (params.agent as string) ?? 'cerebro';
  const subagentChoices = [
    { slug: 'cerebro', label: 'Cerebro (global)' },
    ...experts
      .filter((e) => e.slug && e.slug !== 'cerebro' && e.isEnabled)
      .map((e) => ({ slug: e.slug as string, label: e.name })),
  ];
  const isCustom = !subagentChoices.some((c) => c.slug === agent);

  const [queryTouched, setQueryTouched] = useState(false);
  const queryEmpty = query.trim().length === 0;
  const showQueryError = queryTouched && queryEmpty;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-text-secondary">
          Looks up notes saved in an expert&rsquo;s memory. Pick &ldquo;Cerebro&rdquo;
          to search the global notebook, or an expert to search just their own
          notes. Claude Code reads the markdown files and returns relevant
          matches.
        </p>
      </div>

      <div>
        <FieldLabel text="What are you looking for?" hint="stepQuery" />
        <textarea
          ref={queryRef}
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          onBlur={() => setQueryTouched(true)}
          rows={3}
          placeholder="e.g. What did I learn about our pricing tests?"
          aria-invalid={showQueryError}
          className={clsx(textareaCls, showQueryError && 'border-red-500/60 focus:border-red-500/60')}
        />
        {showQueryError ? (
          <FieldError text="Required — enter what you want to recall." />
        ) : (
          <p className="mt-1 text-[11px] text-text-tertiary">
            Plain English works best. Use chips below to weave in output from a
            connected step.
          </p>
        )}
      </div>

      <AvailableVariablesSection
        step={step}
        onInsert={insertAtCursor}
        sourceSteps={sourceSteps}
        onAddMapping={onAddMapping}
      />

      <div>
        <FieldLabel text="Whose memory" hint="fieldMemoryScope" />
        <select
          value={isCustom ? '__custom__' : agent}
          onChange={(e) => {
            if (e.target.value === '__custom__') return;
            onChange({ ...paramsRef.current, agent: e.target.value });
          }}
          className={selectCls}
        >
          {subagentChoices.map((c) => (
            <option key={c.slug} value={c.slug}>{c.label}</option>
          ))}
          {isCustom && <option value="__custom__">{agent} (custom)</option>}
        </select>
        <p className="mt-1 text-[11px] text-text-tertiary">
          &ldquo;Cerebro&rdquo; searches your shared global notes. Pick an expert
          to search only their own notebook.
        </p>
      </div>

      <div>
        <FieldLabel text="Max results" hint="fieldMaxResults" />
        <input
          type="number"
          min={1}
          max={20}
          value={(params.max_results as number) ?? 5}
          onChange={(e) =>
            onChange({
              ...paramsRef.current,
              max_results: parseInt(e.target.value) || 5,
            })
          }
          className={inputCls}
        />
        <p className="mt-1 text-[11px] text-text-tertiary">
          Caps how many matches are returned to the next step.
        </p>
      </div>

      <ModelPicker
        value={(params.model as string) ?? DEFAULT_CLAUDE_MODEL}
        onChange={(id) => onChange({ ...paramsRef.current, model: id })}
      />
    </div>
  );
}

function SearchWebParams({ params, onChange, step, sourceSteps, onAddMapping }: PWithStep) {
  const [query, setQuery] = useState((params.query as string) ?? '');
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const queryRef = useRef<HTMLTextAreaElement>(null);

  const handleQueryChange = (v: string) => {
    setQuery(v);
    onChange({ ...paramsRef.current, query: v });
  };

  const insertAtCursor = (token: string) => {
    const el = queryRef.current;
    if (!el) return;
    const start = el.selectionStart ?? query.length;
    const end = el.selectionEnd ?? query.length;
    const next = query.slice(0, start) + token + query.slice(end);
    handleQueryChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const [queryTouched, setQueryTouched] = useState(false);
  const queryEmpty = query.trim().length === 0;
  const showQueryError = queryTouched && queryEmpty;

  const includeAnswer = (params.include_ai_answer as boolean) ?? false;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-text-secondary">
          Searches the web using Claude Code&rsquo;s built-in tools. Returns a
          list of titles, URLs, and snippets — optionally with a 1-3 sentence
          synthesized answer.
        </p>
      </div>

      <div>
        <FieldLabel text="What should we search for?" hint="stepQuery" />
        <textarea
          ref={queryRef}
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          onBlur={() => setQueryTouched(true)}
          rows={3}
          placeholder="e.g. Latest CPI release for Q1 2026"
          aria-invalid={showQueryError}
          className={clsx(textareaCls, showQueryError && 'border-red-500/60 focus:border-red-500/60')}
        />
        {showQueryError ? (
          <FieldError text="Required — web search needs a query." />
        ) : (
          <p className="mt-1 text-[11px] text-text-tertiary">
            Write the search exactly how you&rsquo;d type it into Google. Click
            a variable chip below to splice in an upstream step&rsquo;s output.
          </p>
        )}
      </div>

      <AvailableVariablesSection
        step={step}
        onInsert={insertAtCursor}
        sourceSteps={sourceSteps}
        onAddMapping={onAddMapping}
      />

      <div>
        <FieldLabel text="Max results" hint="fieldMaxResults" />
        <input
          type="number"
          min={1}
          max={10}
          value={(params.max_results as number) ?? 5}
          onChange={(e) =>
            onChange({
              ...paramsRef.current,
              max_results: parseInt(e.target.value) || 5,
            })
          }
          className={inputCls}
        />
        <p className="mt-1 text-[11px] text-text-tertiary">
          How many links to bring back. Keep this small — downstream steps
          usually only need the top few.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <FieldLabel text="Synthesize an answer" hint="fieldIncludeAiAnswer" />
          <Toggle
            checked={includeAnswer}
            onChange={() =>
              onChange({
                ...paramsRef.current,
                include_ai_answer: !includeAnswer,
              })
            }
          />
        </div>
        <p className="mt-1 text-[11px] text-text-tertiary">
          When on, Claude also returns a short synthesis of the top results
          alongside the raw list.
        </p>
      </div>

      <ModelPicker
        value={(params.model as string) ?? 'claude-haiku-4-5'}
        onChange={(id) => onChange({ ...paramsRef.current, model: id })}
      />
    </div>
  );
}

function SearchDocumentsParams({ params, onChange, step, sourceSteps, onAddMapping }: PWithStep) {
  const { buckets } = useFiles();

  const [query, setQuery] = useState((params.query as string) ?? '');
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const queryRef = useRef<HTMLTextAreaElement>(null);

  const handleQueryChange = (v: string) => {
    setQuery(v);
    onChange({ ...paramsRef.current, query: v });
  };

  const insertAtCursor = (token: string) => {
    const el = queryRef.current;
    if (!el) return;
    const start = el.selectionStart ?? query.length;
    const end = el.selectionEnd ?? query.length;
    const next = query.slice(0, start) + token + query.slice(end);
    handleQueryChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const bucketId = (params.bucket_id as string) ?? '';
  const [queryTouched, setQueryTouched] = useState(false);
  const [bucketTouched, setBucketTouched] = useState(false);
  const queryEmpty = query.trim().length === 0;
  const bucketEmpty = bucketId.trim().length === 0;
  const showQueryError = queryTouched && queryEmpty;
  const showBucketError = bucketTouched && bucketEmpty;

  const hasBuckets = buckets.length > 0;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-text-secondary">
          Asks Claude Code to answer your query using files from a Files bucket.
          Upload documents to a bucket on the Files screen, then pick it here —
          Claude reads the files directly, no vector setup required.
        </p>
      </div>

      <div>
        <FieldLabel text="What should we find?" hint="stepQuery" />
        <textarea
          ref={queryRef}
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          onBlur={() => setQueryTouched(true)}
          rows={3}
          placeholder="e.g. Summarize the termination clause across all contracts."
          aria-invalid={showQueryError}
          className={clsx(textareaCls, showQueryError && 'border-red-500/60 focus:border-red-500/60')}
        />
        {showQueryError ? (
          <FieldError text="Required — describe what to pull from the documents." />
        ) : (
          <p className="mt-1 text-[11px] text-text-tertiary">
            Describe the question or the passage you want. Chips below let you
            drop in output from an upstream step.
          </p>
        )}
      </div>

      <AvailableVariablesSection
        step={step}
        onInsert={insertAtCursor}
        sourceSteps={sourceSteps}
        onAddMapping={onAddMapping}
      />

      <div>
        <FieldLabel text="Bucket" hint="fieldBucket" />
        {!hasBuckets ? (
          <div className="rounded-lg border border-dashed border-border-subtle bg-bg-base/40 px-3 py-3 text-center">
            <p className="text-[11px] text-text-tertiary">
              No buckets yet. Head to the Files screen, create a bucket, and
              upload the documents you want searched.
            </p>
          </div>
        ) : (
          <select
            value={bucketId}
            onChange={(e) => onChange({ ...paramsRef.current, bucket_id: e.target.value })}
            onBlur={() => setBucketTouched(true)}
            aria-invalid={showBucketError}
            className={clsx(
              selectCls,
              showBucketError && 'border-red-500/60 focus:border-red-500/60',
            )}
          >
            <option value="">Pick a bucket…</option>
            {buckets.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        )}
        {showBucketError ? (
          <FieldError text="Required — choose which bucket to search." />
        ) : hasBuckets ? (
          <p className="mt-1 text-[11px] text-text-tertiary">
            One bucket per step. Use separate Search Documents nodes to span
            multiple buckets.
          </p>
        ) : null}
      </div>

      <div>
        <FieldLabel text="Max results" hint="fieldMaxResults" />
        <input
          type="number"
          min={1}
          max={20}
          value={(params.max_results as number) ?? 5}
          onChange={(e) =>
            onChange({
              ...paramsRef.current,
              max_results: parseInt(e.target.value) || 5,
            })
          }
          className={inputCls}
        />
        <p className="mt-1 text-[11px] text-text-tertiary">
          How many passages to return, each with a file path and snippet.
        </p>
      </div>

      <ModelPicker
        value={(params.model as string) ?? DEFAULT_CLAUDE_MODEL}
        onChange={(id) => onChange({ ...paramsRef.current, model: id })}
      />
    </div>
  );
}

const SAVE_MEMORY_MODES: { value: 'write' | 'extract'; label: string; hint: string }[] = [
  { value: 'write', label: 'Write as-is', hint: 'Save content verbatim' },
  { value: 'extract', label: 'Distill first', hint: 'Claude pulls out facts' },
];

function SaveToMemoryParams({ params, onChange, step, sourceSteps, onAddMapping }: PWithStep) {
  const { experts } = useExperts();

  const [content, setContent] = useState((params.content as string) ?? '');
  const [topic, setTopic] = useState((params.topic as string) ?? '');
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const contentRef = useRef<HTMLTextAreaElement>(null);

  const handleContentChange = (v: string) => {
    setContent(v);
    onChange({ ...paramsRef.current, content: v });
  };
  const handleTopicChange = (v: string) => {
    setTopic(v);
    onChange({ ...paramsRef.current, topic: v });
  };

  const insertAtCursor = (token: string) => {
    const el = contentRef.current;
    if (!el) return;
    const start = el.selectionStart ?? content.length;
    const end = el.selectionEnd ?? content.length;
    const next = content.slice(0, start) + token + content.slice(end);
    handleContentChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const agent = (params.agent as string) ?? 'cerebro';
  const subagentChoices = [
    { slug: 'cerebro', label: 'Cerebro (global)' },
    ...experts
      .filter((e) => e.slug && e.slug !== 'cerebro' && e.isEnabled)
      .map((e) => ({ slug: e.slug as string, label: e.name })),
  ];
  const isCustom = !subagentChoices.some((c) => c.slug === agent);

  const mode: 'write' | 'extract' = params.mode === 'extract' ? 'extract' : 'write';

  const [contentTouched, setContentTouched] = useState(false);
  const contentEmpty = content.trim().length === 0;
  const showContentError = contentTouched && contentEmpty;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-text-secondary">
          Appends an entry to an auto-dated markdown file in an expert&rsquo;s
          memory. Pick &ldquo;Cerebro&rdquo; for shared global notes, or an
          expert to write into their own notebook.
        </p>
      </div>

      <div>
        <FieldLabel text="What should we save?" hint="fieldContent" />
        <textarea
          ref={contentRef}
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          onBlur={() => setContentTouched(true)}
          rows={4}
          placeholder="e.g. {{ask_ai.response}} — or type the note yourself."
          aria-invalid={showContentError}
          className={clsx(textareaCls, showContentError && 'border-red-500/60 focus:border-red-500/60')}
        />
        {showContentError ? (
          <FieldError text="Required — nothing to save without content." />
        ) : (
          <p className="mt-1 text-[11px] text-text-tertiary">
            Most often you&rsquo;ll click a chip below to reference an upstream
            step&rsquo;s output. Plain text works too.
          </p>
        )}
      </div>

      <AvailableVariablesSection
        step={step}
        onInsert={insertAtCursor}
        sourceSteps={sourceSteps}
        onAddMapping={onAddMapping}
      />

      <div>
        <FieldLabel text="How should we save it?" hint="fieldSaveMode" />
        <div className="grid grid-cols-2 gap-1.5">
          {SAVE_MEMORY_MODES.map((opt) => {
            const active = opt.value === mode;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange({ ...paramsRef.current, mode: opt.value })}
                aria-pressed={active}
                className={clsx(
                  'rounded-lg border px-2 py-2 text-center transition-colors',
                  active
                    ? 'border-accent/50 bg-accent/10 text-accent'
                    : 'border-border-subtle bg-bg-base text-text-secondary hover:border-accent/30',
                )}
              >
                <div className="text-[11px] font-medium">{opt.label}</div>
                <div className="text-[10px] text-text-tertiary">{opt.hint}</div>
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] text-text-tertiary">
          &ldquo;Distill first&rdquo; runs Claude to convert the content into a
          bulleted fact list before saving — useful when the source is a long
          passage.
        </p>
      </div>

      <div>
        <FieldLabel text="Topic (optional)" hint="fieldSaveTopic" />
        <input
          value={topic}
          onChange={(e) => handleTopicChange(e.target.value)}
          placeholder="e.g. Q1 pricing experiments"
          className={inputCls}
        />
        <p className="mt-1 text-[11px] text-text-tertiary">
          Appears in the entry&rsquo;s header so you can skim dated files later.
        </p>
      </div>

      <div>
        <FieldLabel text="Whose memory" hint="fieldMemoryScope" />
        <select
          value={isCustom ? '__custom__' : agent}
          onChange={(e) => {
            if (e.target.value === '__custom__') return;
            onChange({ ...paramsRef.current, agent: e.target.value });
          }}
          className={selectCls}
        >
          {subagentChoices.map((c) => (
            <option key={c.slug} value={c.slug}>{c.label}</option>
          ))}
          {isCustom && <option value="__custom__">{agent} (custom)</option>}
        </select>
        <p className="mt-1 text-[11px] text-text-tertiary">
          Writes into <code className="text-text-secondary">routines/&lt;today&gt;.md</code>
          {' '}under that agent&rsquo;s memory directory.
        </p>
      </div>

      {mode === 'extract' && (
        <ModelPicker
          value={(params.model as string) ?? DEFAULT_CLAUDE_MODEL}
          onChange={(id) => onChange({ ...paramsRef.current, model: id })}
        />
      )}
    </div>
  );
}

// ── Integration Param Forms ───────────────────────────────────

function HttpRequestParams({ params, onChange }: P) {
  const headers = (params.headers as { key: string; value: string }[]) ?? [];

  const updateHeader = (index: number, field: string, value: string) => {
    const updated = [...headers];
    updated[index] = { ...updated[index], [field]: value };
    onChange({ ...params, headers: updated });
  };

  const addHeader = () => {
    onChange({ ...params, headers: [...headers, { key: '', value: '' }] });
  };

  const removeHeader = (index: number) => {
    onChange({ ...params, headers: headers.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="w-24">
          <FieldLabel text="Method" hint="fieldHttpMethod" />
          <select
            value={(params.method as string) ?? 'GET'}
            onChange={(e) => onChange({ ...params, method: e.target.value })}
            className={selectCls}
          >
            <option>GET</option>
            <option>POST</option>
            <option>PUT</option>
            <option>PATCH</option>
            <option>DELETE</option>
          </select>
        </div>
        <div className="flex-1">
          <FieldLabel text="URL" hint="fieldHttpUrl" />
          <input
            value={(params.url as string) ?? ''}
            onChange={(e) => onChange({ ...params, url: e.target.value })}
            placeholder="https://api.example.com/..."
            className={inputCls}
          />
        </div>
      </div>

      <div>
        <FieldLabel text="Headers" hint="fieldHttpHeaders" />
        <div className="space-y-1.5">
          {headers.map((h, i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <input
                value={h.key}
                onChange={(e) => updateHeader(i, 'key', e.target.value)}
                placeholder="Key"
                className={`${inputCls} flex-1`}
              />
              <input
                value={h.value}
                onChange={(e) => updateHeader(i, 'value', e.target.value)}
                placeholder="Value"
                className={`${inputCls} flex-1`}
              />
              <button
                onClick={() => removeHeader(i)}
                className="p-1 text-text-tertiary hover:text-red-400 transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={addHeader}
          className="mt-1.5 text-[11px] text-accent hover:text-accent/80 transition-colors"
        >
          + Add Header
        </button>
      </div>

      <div>
        <FieldLabel text="Body (JSON)" hint="fieldHttpBody" />
        <textarea
          value={(params.body as string) ?? ''}
          onChange={(e) => onChange({ ...params, body: e.target.value })}
          rows={4}
          placeholder='{"key": "{{step_name.field}}"}'
          className={`${textareaCls} font-mono`}
        />
      </div>

      <div>
        <FieldLabel text="Authentication" hint="fieldAuth" />
        <select
          value={(params.auth_type as string) ?? 'none'}
          onChange={(e) => onChange({ ...params, auth_type: e.target.value })}
          className={selectCls}
        >
          <option value="none">None</option>
          <option value="bearer">Bearer Token</option>
          <option value="basic">Basic Auth</option>
          <option value="api_key">API Key</option>
        </select>
      </div>

      <div>
        <FieldLabel text="Timeout (seconds)" hint="fieldTimeoutSeconds" />
        <input
          type="number" min={1}
          value={(params.timeout as number) ?? 30}
          onChange={(e) => onChange({ ...params, timeout: parseInt(e.target.value) || 30 })}
          className={inputCls}
        />
      </div>
    </div>
  );
}

function RunCommandParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Command" hint="stepCommand" />
        <input
          value={(params.command as string) ?? ''}
          onChange={(e) => onChange({ ...params, command: e.target.value })}
          placeholder="git, npm, python, etc."
          className={inputCls}
        />
      </div>
      <div>
        <FieldLabel text="Arguments" hint="fieldArguments" />
        <textarea
          value={(params.args as string) ?? ''}
          onChange={(e) => onChange({ ...params, args: e.target.value })}
          rows={2}
          placeholder="Command arguments... Use {{step_name.field}}"
          className={`${textareaCls} font-mono`}
        />
      </div>
      <div>
        <FieldLabel text="Working Directory" hint="fieldWorkingDir" />
        <input
          value={(params.working_directory as string) ?? ''}
          onChange={(e) => onChange({ ...params, working_directory: e.target.value })}
          placeholder="/path/to/project"
          className={inputCls}
        />
      </div>
      <div>
        <FieldLabel text="Timeout (seconds)" hint="fieldTimeoutSeconds" />
        <input
          type="number" min={1}
          value={(params.timeout as number) ?? 300}
          onChange={(e) => onChange({ ...params, timeout: parseInt(e.target.value) || 300 })}
          className={inputCls}
        />
      </div>
    </div>
  );
}

function ClaudeCodeParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Mode" hint="fieldClaudeMode" />
        <select
          value={(params.mode as string) ?? 'ask'}
          onChange={(e) => onChange({ ...params, mode: e.target.value })}
          className={selectCls}
        >
          <option value="ask">Ask (read-only)</option>
          <option value="plan">Plan (analyze, no edits)</option>
          <option value="implement">Implement (full access)</option>
          <option value="review">Review (git-aware)</option>
        </select>
      </div>
      <div>
        <FieldLabel text="Prompt" hint="stepPrompt" />
        <textarea
          value={(params.prompt as string) ?? ''}
          onChange={(e) => onChange({ ...params, prompt: e.target.value })}
          rows={5}
          placeholder="What should Claude Code do?"
          className={textareaCls}
        />
      </div>
      <div>
        <FieldLabel text="Working Directory" hint="fieldWorkingDir" />
        <input
          value={(params.working_directory as string) ?? ''}
          onChange={(e) => onChange({ ...params, working_directory: e.target.value })}
          placeholder="/path/to/project"
          className={inputCls}
        />
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <FieldLabel text="Max Turns" hint="fieldMaxTurns" />
          <input
            type="number" min={1}
            value={(params.max_turns as number) ?? 50}
            onChange={(e) => onChange({ ...params, max_turns: parseInt(e.target.value) || 50 })}
            className={inputCls}
          />
        </div>
        <div className="flex-1">
          <FieldLabel text="Timeout (s)" hint="fieldTimeoutSeconds" />
          <input
            type="number" min={1}
            value={(params.timeout as number) ?? 600}
            onChange={(e) => onChange({ ...params, timeout: parseInt(e.target.value) || 600 })}
            className={inputCls}
          />
        </div>
      </div>
    </div>
  );
}

function WaitForWebhookParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Match Path" hint="fieldMatchPath" />
        <input
          value={(params.match_path as string) ?? ''}
          onChange={(e) => onChange({ ...params, match_path: e.target.value })}
          placeholder="/my-webhook-path"
          className={inputCls}
        />
      </div>
      <div>
        <FieldLabel text="Timeout (seconds)" hint="fieldTimeoutSeconds" />
        <input
          type="number" min={1}
          value={(params.timeout as number) ?? 3600}
          onChange={(e) => onChange({ ...params, timeout: parseInt(e.target.value) || 3600 })}
          className={inputCls}
        />
      </div>
      <div>
        <FieldLabel text="Description" hint="fieldDescription" />
        <textarea
          value={(params.description as string) ?? ''}
          onChange={(e) => onChange({ ...params, description: e.target.value })}
          rows={2}
          placeholder="What webhook are we waiting for?"
          className={textareaCls}
        />
      </div>
    </div>
  );
}

function RunScriptParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Language" hint="fieldLanguage" />
        <select
          value={(params.language as string) ?? 'python'}
          onChange={(e) => onChange({ ...params, language: e.target.value })}
          className={selectCls}
        >
          <option value="python">Python</option>
          <option value="javascript">JavaScript</option>
        </select>
      </div>
      <div>
        <FieldLabel text="Code" hint="fieldCode" />
        <textarea
          value={(params.code as string) ?? ''}
          onChange={(e) => onChange({ ...params, code: e.target.value })}
          rows={15}
          placeholder={
            (params.language as string) === 'javascript'
              ? '// Access inputs via `input` object\n// Set results on `output` object\noutput.result = input.data;'
              : '# Access inputs via `input` dict\n# Print JSON to stdout for result\nimport json\nprint(json.dumps({"result": input}))'
          }
          className={`${textareaCls} font-mono text-[11px] leading-relaxed`}
        />
      </div>
      <div>
        <FieldLabel text="Timeout (seconds)" hint="fieldTimeoutSeconds" />
        <input
          type="number" min={1}
          value={(params.timeout as number) ?? 30}
          onChange={(e) => onChange({ ...params, timeout: parseInt(e.target.value) || 30 })}
          className={inputCls}
        />
      </div>
    </div>
  );
}

// ── Logic Param Forms ─────────────────────────────────────────

function ConditionParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="If" hint="fieldConditionField" />
        <input
          value={(params.field as string) ?? ''}
          onChange={(e) => onChange({ ...params, field: e.target.value })}
          placeholder="{{step_name.field}}"
          className={inputCls}
        />
      </div>
      <div>
        <FieldLabel text="Operator" hint="fieldConditionOperator" />
        <select
          value={(params.operator as string) ?? 'equals'}
          onChange={(e) => onChange({ ...params, operator: e.target.value })}
          className={selectCls}
        >
          <option value="equals">equals</option>
          <option value="not_equals">not equals</option>
          <option value="contains">contains</option>
          <option value="greater_than">greater than</option>
          <option value="less_than">less than</option>
          <option value="is_empty">is empty</option>
          <option value="is_not_empty">is not empty</option>
          <option value="matches_regex">matches regex</option>
        </select>
      </div>
      <div>
        <FieldLabel text="Value" hint="fieldConditionValue" />
        <input
          value={(params.value as string) ?? ''}
          onChange={(e) => onChange({ ...params, value: e.target.value })}
          placeholder="Comparison value"
          className={inputCls}
        />
      </div>
    </div>
  );
}

function LoopParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Items Field" hint="stepItemsField" />
        <input
          value={(params.items_field as string) ?? ''}
          onChange={(e) => onChange({ ...params, items_field: e.target.value })}
          placeholder="{{step_name.results}} — array to iterate"
          className={inputCls}
        />
      </div>
      <div>
        <FieldLabel text="Variable Name" hint="fieldVariableName" />
        <input
          value={(params.variable_name as string) ?? 'item'}
          onChange={(e) => onChange({ ...params, variable_name: e.target.value })}
          placeholder="item"
          className={inputCls}
        />
        <p className="text-[10px] text-text-tertiary mt-1">
          Access current item as {'{{'}variable_name{'}}'}
        </p>
      </div>
    </div>
  );
}

function DelayParams({ params, onChange }: P) {
  return (
    <div className="flex gap-3">
      <div className="flex-1">
        <FieldLabel text="Duration" hint="fieldDuration" />
        <input
          type="number" min={1}
          value={(params.duration as number) ?? 1}
          onChange={(e) => onChange({ ...params, duration: parseInt(e.target.value) || 1 })}
          className={inputCls}
        />
      </div>
      <div className="flex-1">
        <FieldLabel text="Unit" hint="fieldDurationUnit" />
        <select
          value={(params.unit as string) ?? 'seconds'}
          onChange={(e) => onChange({ ...params, unit: e.target.value })}
          className={selectCls}
        >
          <option value="seconds">Seconds</option>
          <option value="minutes">Minutes</option>
          <option value="hours">Hours</option>
        </select>
      </div>
    </div>
  );
}

function ApprovalGateParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Summary" hint="fieldApprovalSummary" />
        <textarea
          value={(params.summary as string) ?? ''}
          onChange={(e) => onChange({ ...params, summary: e.target.value })}
          rows={3}
          placeholder="Describe what the reviewer should check..."
          className={textareaCls}
        />
      </div>
      <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
        <p className="text-[11px] text-amber-300 leading-relaxed">
          Execution will pause at this node and wait for manual approval.
          The run appears in the Approvals screen until a decision is made.
        </p>
      </div>
    </div>
  );
}

// ── Output Param Forms ────────────────────────────────────────

function SendMessageParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Message" hint="stepMessage" />
        <textarea
          value={(params.message as string) ?? ''}
          onChange={(e) => onChange({ ...params, message: e.target.value })}
          rows={4}
          placeholder="Message text... Use {{step_name.field}} for variables"
          className={textareaCls}
        />
      </div>
      <div>
        <FieldLabel text="Target" hint="fieldNotifyTarget" />
        <select
          value={(params.target as string) ?? 'cerebro_chat'}
          onChange={(e) => onChange({ ...params, target: e.target.value })}
          className={selectCls}
        >
          <option value="cerebro_chat">Cerebro Chat</option>
        </select>
      </div>
    </div>
  );
}

function NotificationParams({ params, onChange, step, sourceSteps, onAddMapping }: PWithStep) {
  // Local state mirrors the Ask AI pattern. Keeps typing smooth even when
  // the parent's debounced onChange hasn't propagated the latest value
  // into `params` yet — unrelated re-renders (context updates, ReactFlow
  // ticks, dirty-flag flips) would otherwise snap the controlled value
  // back to the stale prop and eat characters.
  const [title, setTitle] = useState((params.title as string) ?? '');
  const [body, setBody] = useState((params.body as string) ?? '');
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<'title' | 'body'>('title');

  const handleTitleChange = (v: string) => {
    setTitle(v);
    onChange({ ...paramsRef.current, title: v });
  };
  const handleBodyChange = (v: string) => {
    setBody(v);
    onChange({ ...paramsRef.current, body: v });
  };

  const insertAtCursor = (token: string) => {
    const field = lastFocused.current;
    const el = field === 'title' ? titleRef.current : bodyRef.current;
    if (!el) return;
    const current = field === 'title' ? title : body;
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    if (field === 'title') handleTitleChange(next);
    else handleBodyChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const urgency = (params.urgency as string) ?? 'normal';
  const [titleTouched, setTitleTouched] = useState(false);
  const titleEmpty = title.trim().length === 0;
  const showTitleError = titleTouched && titleEmpty;

  return (
    <div className="space-y-4">
      <div>
        <FieldLabel text="Headline" hint="stepTitle" />
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          onFocus={() => { lastFocused.current = 'title'; }}
          onBlur={() => setTitleTouched(true)}
          placeholder="e.g. Daily brief is ready"
          aria-invalid={showTitleError}
          className={clsx(inputCls, showTitleError && 'border-red-500/60 focus:border-red-500/60')}
        />
        {showTitleError ? (
          <FieldError text="Required — the notification won't send without a headline." />
        ) : (
          <p className="mt-1 text-[11px] text-text-tertiary">
            Short text shown at the top of the notification. Required.
          </p>
        )}
      </div>

      <div>
        <FieldLabel text="Message (optional)" hint="fieldNotifyBody" />
        <textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => handleBodyChange(e.target.value)}
          onFocus={() => { lastFocused.current = 'body'; }}
          rows={4}
          placeholder="e.g. Here's what the AI found."
          className={textareaCls}
        />
        <p className="mt-1 text-[11px] text-text-tertiary">
          Longer text shown under the headline. If you&rsquo;ve connected
          another step, click its chip below to insert its output.
        </p>
      </div>

      <AvailableVariablesSection
        step={step}
        onInsert={insertAtCursor}
        sourceSteps={sourceSteps}
        onAddMapping={onAddMapping}
      />

      <div>
        <FieldLabel text="Urgency" hint="fieldNotifyUrgency" />
        <select
          value={urgency}
          onChange={(e) => onChange({ ...paramsRef.current, urgency: e.target.value })}
          className={selectCls}
        >
          <option value="normal">Normal — standard banner</option>
          <option value="critical">Critical — sticky / alert style</option>
        </select>
        <p className="mt-1 text-[11px] text-text-tertiary">
          Critical notifications stay on screen until dismissed on platforms
          that support it (Linux). On macOS and Windows, both show as
          standard banners.
        </p>
      </div>
    </div>
  );
}

function StubParams({ name }: { name: string }) {
  return (
    <div className="rounded-lg bg-bg-base border border-border-subtle p-3">
      <p className="text-xs text-text-tertiary text-center">
        {name} configuration coming soon.
      </p>
    </div>
  );
}

// ── Param Form Router ─────────────────────────────────────────

function ParamForm({
  actionType,
  params,
  onChange,
  step,
  sourceSteps,
  onAddMapping,
}: {
  actionType: string;
  step?: RoutineStepData;
  sourceSteps?: SourceStepInfo[];
  onAddMapping?: (mapping: {
    sourceStepId: string;
    sourceField: string;
    targetField: string;
  }) => void;
} & P) {
  const resolved = resolveActionType(actionType);

  switch (resolved) {
    // AI
    case 'ask_ai': return <AskAiParams params={params} onChange={onChange} step={step} sourceSteps={sourceSteps} onAddMapping={onAddMapping} />;
    case 'run_expert': return <RunExpertParams params={params} onChange={onChange} step={step} sourceSteps={sourceSteps} onAddMapping={onAddMapping} />;
    case 'classify': return <ClassifyParams params={params} onChange={onChange} step={step} sourceSteps={sourceSteps} onAddMapping={onAddMapping} />;
    case 'extract': return <ExtractParams params={params} onChange={onChange} step={step} sourceSteps={sourceSteps} onAddMapping={onAddMapping} />;
    case 'summarize': return <SummarizeParams params={params} onChange={onChange} step={step} sourceSteps={sourceSteps} />;

    // Knowledge
    case 'search_memory': return <SearchMemoryParams params={params} onChange={onChange} step={step} sourceSteps={sourceSteps} onAddMapping={onAddMapping} />;
    case 'search_web': return <SearchWebParams params={params} onChange={onChange} step={step} sourceSteps={sourceSteps} onAddMapping={onAddMapping} />;
    case 'search_documents': return <SearchDocumentsParams params={params} onChange={onChange} step={step} sourceSteps={sourceSteps} onAddMapping={onAddMapping} />;
    case 'save_to_memory': return <SaveToMemoryParams params={params} onChange={onChange} step={step} sourceSteps={sourceSteps} onAddMapping={onAddMapping} />;

    // Integrations
    case 'http_request': return <HttpRequestParams params={params} onChange={onChange} />;
    case 'run_command': return <RunCommandParams params={params} onChange={onChange} />;
    case 'run_claude_code': return <ClaudeCodeParams params={params} onChange={onChange} />;

    // Logic
    case 'wait_for_webhook': return <WaitForWebhookParams params={params} onChange={onChange} />;
    case 'run_script': return <RunScriptParams params={params} onChange={onChange} />;
    case 'condition': return <ConditionParams params={params} onChange={onChange} />;
    case 'loop': return <LoopParams params={params} onChange={onChange} />;
    case 'delay': return <DelayParams params={params} onChange={onChange} />;
    case 'approval_gate': return <ApprovalGateParams params={params} onChange={onChange} />;

    // Output
    case 'send_message': return <SendMessageParams params={params} onChange={onChange} />;
    case 'send_notification': return <NotificationParams params={params} onChange={onChange} step={step} sourceSteps={sourceSteps} onAddMapping={onAddMapping} />;

    default:
      return <StubParams name={ACTION_META[actionType]?.name ?? actionType} />;
  }
}

// ── Main Component ────────────────────────────────────────────

interface StepConfigPanelProps {
  node: Node;
  allNodes?: Node[];
  onUpdate: (nodeId: string, partial: Record<string, unknown>) => void;
  onClose: () => void;
}

export default function StepConfigPanel({ node, allNodes, onUpdate, onClose }: StepConfigPanelProps) {
  const { t } = useTranslation();
  const d = node.data as RoutineStepData;
  const resolved = resolveActionType(d.actionType);
  const meta = ACTION_META[resolved] ?? ACTION_META[d.actionType];

  const sourceSteps = useMemo<SourceStepInfo[]>(() => {
    if (!allNodes) return [];
    return allNodes
      .filter((n) => n.type === 'routineStep')
      .map((n) => {
        const nd = n.data as RoutineStepData;
        return { id: n.id, name: nd.name, actionType: nd.actionType };
      });
  }, [allNodes]);

  const stepsById = useMemo(() => {
    const m = new Map<string, SourceStepInfo>();
    for (const s of sourceSteps) m.set(s.id, s);
    return m;
  }, [sourceSteps]);

  const handleAddMapping = useCallback(
    (mapping: { sourceStepId: string; sourceField: string; targetField: string }) => {
      const existing = d.inputMappings ?? [];
      if (
        existing.some(
          (m) =>
            m.sourceStepId === mapping.sourceStepId &&
            m.sourceField === mapping.sourceField,
        )
      ) {
        return;
      }
      onUpdate(node.id, { inputMappings: [...existing, mapping] });
    },
    [node.id, onUpdate, d.inputMappings],
  );

  const [stepName, setStepName] = useState(d.name);

  useEffect(() => {
    setStepName(d.name);
  }, [d.name]);

  const handleNameBlur = () => {
    const trimmed = stepName.trim();
    if (trimmed && trimmed !== d.name) {
      onUpdate(node.id, { name: trimmed });
    } else {
      setStepName(d.name);
    }
  };

  const paramsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleParamsChange = useCallback(
    (params: Record<string, unknown>) => {
      if (paramsTimerRef.current) clearTimeout(paramsTimerRef.current);
      paramsTimerRef.current = setTimeout(() => {
        onUpdate(node.id, { params });
      }, 150);
    },
    [node.id, onUpdate],
  );
  useEffect(() => {
    return () => { if (paramsTimerRef.current) clearTimeout(paramsTimerRef.current); };
  }, []);

  return (
    <div className="absolute top-0 right-0 bottom-0 w-[380px] bg-bg-surface border-l border-border-subtle animate-slide-in-right z-30 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle flex-shrink-0">
        <h3 className="text-sm font-semibold text-text-primary tracking-wide">
          Step Configuration
        </h3>
        <Tooltip label={t('routineTooltips.closePanel')} shortcut="Esc">
          <button
            onClick={onClose}
            aria-label={t('routineTooltips.closePanel')}
            className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <X size={16} />
          </button>
        </Tooltip>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-5 space-y-6">
        {/* Identity */}
        <Section label="STEP IDENTITY">
          <div className="space-y-3">
            <div>
              <FieldLabel text="Name" hint="stepName" />
              <input
                value={stepName}
                onChange={(e) => setStepName(e.target.value)}
                onBlur={handleNameBlur}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
              />
            </div>
            <div>
              <FieldLabel text="Action Type" hint="fieldActionType" />
              <div className="flex items-center gap-2">
                {meta && (
                  <div
                    className="w-5 h-5 rounded flex items-center justify-center"
                    style={{ backgroundColor: `${meta.colorHex}20` }}
                  >
                    <meta.icon size={12} style={{ color: meta.colorHex }} />
                  </div>
                )}
                <span className="text-xs font-medium" style={{ color: meta?.colorHex }}>
                  {meta?.name ?? d.actionType}
                </span>
              </div>
            </div>
          </div>
        </Section>

        {/* Parameters */}
        <Section label="PARAMETERS">
          {/* key={node.id} remounts the form (and its local text state)
              when the user selects a different step, so drafts from one
              step never leak into another. */}
          <ParamForm
            key={node.id}
            actionType={d.actionType}
            params={d.params}
            onChange={handleParamsChange}
            step={d}
            sourceSteps={sourceSteps}
            onAddMapping={handleAddMapping}
          />
        </Section>

        {/* Error Handling (hidden for approval gates) */}
        {resolved !== 'approval_gate' && (
          <Section label="ERROR HANDLING">
            <div className="space-y-3">
              <div>
                <FieldLabel text="On Error" hint="stepOnError" />
                <select
                  value={d.onError}
                  onChange={(e) =>
                    onUpdate(node.id, { onError: e.target.value as 'fail' | 'skip' | 'retry' })
                  }
                  className={selectCls}
                >
                  <option value="fail">Fail (stop routine)</option>
                  <option value="skip">Skip (continue)</option>
                  <option value="retry">Retry</option>
                </select>
              </div>

              {d.onError === 'retry' && (
                <div>
                  <FieldLabel text="Max Retries" hint="fieldMaxRetries" />
                  <input
                    type="number" min={1} max={10}
                    value={d.maxRetries ?? 1}
                    onChange={(e) => onUpdate(node.id, { maxRetries: parseInt(e.target.value) || 1 })}
                    className={inputCls}
                  />
                </div>
              )}

              <div>
                <FieldLabel text="Timeout (ms)" hint="fieldTimeoutMs" />
                <input
                  type="number" min={1000} step={1000}
                  value={d.timeoutMs ?? ''}
                  onChange={(e) =>
                    onUpdate(node.id, {
                      timeoutMs: e.target.value ? parseInt(e.target.value) : undefined,
                    })
                  }
                  placeholder="300000"
                  className={inputCls}
                />
              </div>
            </div>
          </Section>
        )}

        {/* Approval (hidden for approval gates — always on) */}
        {resolved !== 'approval_gate' && (
          <Section label="APPROVAL">
            <Tooltip label={t('routineTooltips.stepRequiresApproval')} side="left">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Shield size={13} className="text-amber-400" />
                  <span className="text-xs text-text-secondary">
                    Require approval before execution
                  </span>
                </div>
                <Toggle
                  checked={d.requiresApproval}
                  onChange={() => onUpdate(node.id, { requiresApproval: !d.requiresApproval })}
                />
              </div>
            </Tooltip>
          </Section>
        )}

        {/* Input Mappings (read-only) */}
        {d.inputMappings && d.inputMappings.length > 0 && (
          <Section label="INPUT MAPPINGS">
            <div className="space-y-1.5">
              {d.inputMappings.map((m, i) => {
                const source = stepsById.get(m.sourceStepId);
                const sourceLabel = source?.name ?? m.sourceStepId;
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-[11px] text-text-tertiary font-mono bg-bg-base rounded px-2.5 py-1.5 border border-border-subtle"
                  >
                    <span className="text-text-secondary">{sourceLabel}</span>
                    <span>.{m.sourceField || 'output'}</span>
                    <span className="text-accent">&rarr;</span>
                    <span className="text-text-secondary">{m.targetField}</span>
                  </div>
                );
              })}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
