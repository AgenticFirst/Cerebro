import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Shield, Info, HelpCircle, AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { Node } from '@xyflow/react';
import type { RoutineStepData } from '../../../utils/dag-flow-mapping';
import { ACTION_META, resolveActionType } from '../../../utils/step-defaults';
import { useExperts } from '../../../context/ExpertContext';
import Toggle from '../../ui/Toggle';
import Tooltip from '../../ui/Tooltip';
import VariablesHelpModal from './VariablesHelpModal';

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
type PWithStep = P & { step?: RoutineStepData };

// ── AI Param Forms ────────────────────────────────────────────

/**
 * Chips listing the variables wired into this step from upstream edges.
 * Clicking a chip drops its {{placeholder}} into the last-focused prompt/system
 * textarea so users never have to guess the exact syntax.
 */
function VariableChips({
  step,
  onInsert,
}: {
  step?: RoutineStepData;
  onInsert: (token: string) => void;
}) {
  const mappings = step?.inputMappings ?? [];
  if (mappings.length === 0) {
    return (
      <p className="text-[11px] text-text-tertiary leading-relaxed">
        No variables yet. Connect an edge from another step into this one, and
        its output will show up here as a <code className="px-1 rounded bg-bg-base text-text-secondary">{'{{variable}}'}</code> you can paste into the prompt.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-text-tertiary">
        Click to insert. These come from steps connected into this one.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {mappings.map((m, i) => {
          const token = `{{${m.targetField}}}`;
          return (
            <button
              key={`${m.sourceStepId}-${m.targetField}-${i}`}
              type="button"
              onClick={() => onInsert(token)}
              title={`From ${m.sourceStepId}.${m.sourceField}`}
              className="px-2 py-0.5 rounded-full text-[11px] font-mono border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            >
              {token}
            </button>
          );
        })}
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
}: {
  step?: RoutineStepData;
  onInsert: (token: string) => void;
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
      <VariableChips step={step} onInsert={onInsert} />
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

function AskAiParams({ params, onChange, step }: PWithStep) {
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
          placeholder="e.g. Summarize the email below in two sentences:&#10;&#10;{{previous_output}}"
          aria-invalid={showPromptError}
          className={clsx(textareaCls, showPromptError && 'border-red-500/60 focus:border-red-500/60')}
        />
        {showPromptError ? (
          <FieldError text="Required — the step will fail without a prompt." />
        ) : (
          <p className="mt-1 text-[11px] text-text-tertiary">
            Write the instruction in plain English. To reference data from a
            connected step, wrap its name in double braces like <code className="px-1 rounded bg-bg-base text-text-secondary">{'{{previous_output}}'}</code>.
          </p>
        )}
      </div>

      <AvailableVariablesSection step={step} onInsert={insertAtCursor} />

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
    </div>
  );
}

function RunExpertParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Expert ID" hint="fieldExpertId" />
        <input
          value={(params.expert_id as string) ?? ''}
          onChange={(e) => onChange({ ...params, expert_id: e.target.value })}
          placeholder="Select an expert..."
          className={inputCls}
        />
      </div>
      <div>
        <FieldLabel text="Task" hint="stepTask" />
        <textarea
          value={(params.task as string) ?? ''}
          onChange={(e) => onChange({ ...params, task: e.target.value })}
          rows={4}
          placeholder="What should the expert do? Use {{step_name.field}} for variables"
          className={textareaCls}
        />
      </div>
      <div>
        <FieldLabel text="Context (optional)" hint="fieldContext" />
        <textarea
          value={(params.context as string) ?? ''}
          onChange={(e) => onChange({ ...params, context: e.target.value })}
          rows={2}
          placeholder="Additional context..."
          className={textareaCls}
        />
      </div>
      <div>
        <FieldLabel text="Max Turns" hint="fieldMaxTurns" />
        <input
          type="number" min={1}
          value={(params.max_turns as number) ?? 10}
          onChange={(e) => onChange({ ...params, max_turns: parseInt(e.target.value) || 10 })}
          className={inputCls}
        />
      </div>
    </div>
  );
}

function ClassifyParams({ params, onChange }: P) {
  const categories = (params.categories as { id: string; label: string; description: string }[]) ?? [];

  const updateCategory = (index: number, field: string, value: string) => {
    const updated = [...categories];
    updated[index] = { ...updated[index], [field]: value };
    onChange({ ...params, categories: updated });
  };

  const addCategory = () => {
    onChange({ ...params, categories: [...categories, { id: crypto.randomUUID(), label: '', description: '' }] });
  };

  const removeCategory = (index: number) => {
    onChange({ ...params, categories: categories.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Input" hint="fieldInput" />
        <textarea
          value={(params.prompt as string) ?? ''}
          onChange={(e) => onChange({ ...params, prompt: e.target.value })}
          rows={2}
          placeholder="What to classify... Use {{step_name.field}}"
          className={textareaCls}
        />
      </div>
      <div>
        <FieldLabel text="Categories" hint="stepCategories" />
        <div className="space-y-2">
          {categories.map((cat, i) => (
            <div key={cat.id ?? i} className="flex gap-2 items-start">
              <div className="flex-1 space-y-1">
                <input
                  value={cat.label}
                  onChange={(e) => updateCategory(i, 'label', e.target.value)}
                  placeholder="Label"
                  className={inputCls}
                />
                <input
                  value={cat.description}
                  onChange={(e) => updateCategory(i, 'description', e.target.value)}
                  placeholder="Description"
                  className={inputCls}
                />
              </div>
              <button
                onClick={() => removeCategory(i)}
                className="mt-1 p-1 text-text-tertiary hover:text-red-400 transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={addCategory}
          className="mt-2 text-[11px] text-accent hover:text-accent/80 transition-colors"
        >
          + Add Category
        </button>
      </div>
    </div>
  );
}

function ExtractParams({ params, onChange }: P) {
  const schema = (params.schema as { id: string; name: string; type: string; description: string }[]) ?? [];

  const updateField = (index: number, field: string, value: string) => {
    const updated = [...schema];
    updated[index] = { ...updated[index], [field]: value };
    onChange({ ...params, schema: updated });
  };

  const addField = () => {
    onChange({ ...params, schema: [...schema, { id: crypto.randomUUID(), name: '', type: 'string', description: '' }] });
  };

  const removeField = (index: number) => {
    onChange({ ...params, schema: schema.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Input" hint="fieldInput" />
        <textarea
          value={(params.prompt as string) ?? ''}
          onChange={(e) => onChange({ ...params, prompt: e.target.value })}
          rows={2}
          placeholder="What to extract from... Use {{step_name.field}}"
          className={textareaCls}
        />
      </div>
      <div>
        <FieldLabel text="Schema" hint="stepSchema" />
        <div className="space-y-2">
          {schema.map((field, i) => (
            <div key={field.id ?? i} className="flex gap-2 items-start">
              <div className="flex-1 space-y-1">
                <input
                  value={field.name}
                  onChange={(e) => updateField(i, 'name', e.target.value)}
                  placeholder="Field name"
                  className={inputCls}
                />
                <div className="flex gap-1">
                  <select
                    value={field.type}
                    onChange={(e) => updateField(i, 'type', e.target.value)}
                    className={`${selectCls} w-24`}
                  >
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                    <option value="date">date</option>
                    <option value="array">array</option>
                  </select>
                  <input
                    value={field.description}
                    onChange={(e) => updateField(i, 'description', e.target.value)}
                    placeholder="Description"
                    className={`${inputCls} flex-1`}
                  />
                </div>
              </div>
              <button
                onClick={() => removeField(i)}
                className="mt-1 p-1 text-text-tertiary hover:text-red-400 transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={addField}
          className="mt-2 text-[11px] text-accent hover:text-accent/80 transition-colors"
        >
          + Add Field
        </button>
      </div>
    </div>
  );
}

function SummarizeParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Input Field" hint="fieldInputField" />
        <input
          value={(params.input_field as string) ?? ''}
          onChange={(e) => onChange({ ...params, input_field: e.target.value })}
          placeholder="{{step_name.field}} to summarize"
          className={inputCls}
        />
      </div>
      <div>
        <FieldLabel text="Length" hint="fieldLength" />
        <select
          value={(params.max_length as string) ?? 'medium'}
          onChange={(e) => onChange({ ...params, max_length: e.target.value })}
          className={selectCls}
        >
          <option value="short">Short (1-2 sentences)</option>
          <option value="medium">Medium (paragraph)</option>
          <option value="long">Long (detailed)</option>
        </select>
      </div>
      <div>
        <FieldLabel text="Focus (optional)" hint="fieldFocus" />
        <input
          value={(params.focus as string) ?? ''}
          onChange={(e) => onChange({ ...params, focus: e.target.value })}
          placeholder="What aspect to focus on"
          className={inputCls}
        />
      </div>
    </div>
  );
}

// ── Knowledge Param Forms ─────────────────────────────────────

function SearchMemoryParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Query" hint="stepQuery" />
        <textarea
          value={(params.query as string) ?? ''}
          onChange={(e) => onChange({ ...params, query: e.target.value })}
          rows={2}
          placeholder="What to search for... Use {{step_name.field}}"
          className={textareaCls}
        />
      </div>
      <div>
        <FieldLabel text="Scope" hint="fieldScope" />
        <select
          value={(params.scope as string) ?? 'global'}
          onChange={(e) => onChange({ ...params, scope: e.target.value })}
          className={selectCls}
        >
          <option value="global">Global</option>
          <option value="expert">Expert-specific</option>
        </select>
      </div>
      <div>
        <FieldLabel text="Max Results" hint="fieldMaxResults" />
        <input
          type="number" min={1} max={20}
          value={(params.max_results as number) ?? 5}
          onChange={(e) => onChange({ ...params, max_results: parseInt(e.target.value) || 5 })}
          className={inputCls}
        />
      </div>
    </div>
  );
}

function SearchWebParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Query" hint="stepQuery" />
        <textarea
          value={(params.query as string) ?? ''}
          onChange={(e) => onChange({ ...params, query: e.target.value })}
          rows={2}
          placeholder="What to search for... Use {{step_name.field}}"
          className={textareaCls}
        />
      </div>
      <div>
        <FieldLabel text="Max Results" hint="fieldMaxResults" />
        <input
          type="number" min={1} max={10}
          value={(params.max_results as number) ?? 5}
          onChange={(e) => onChange({ ...params, max_results: parseInt(e.target.value) || 5 })}
          className={inputCls}
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-secondary">Include AI Answer</span>
        <Toggle
          checked={(params.include_ai_answer as boolean) ?? false}
          onChange={() => onChange({ ...params, include_ai_answer: !params.include_ai_answer })}
        />
      </div>
    </div>
  );
}

function SaveToMemoryParams({ params, onChange }: P) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Content" hint="fieldContent" />
        <textarea
          value={(params.content as string) ?? ''}
          onChange={(e) => onChange({ ...params, content: e.target.value })}
          rows={3}
          placeholder="What to save... Use {{step_name.field}}"
          className={textareaCls}
        />
      </div>
      <div>
        <FieldLabel text="Scope" hint="fieldScope" />
        <select
          value={(params.scope as string) ?? 'global'}
          onChange={(e) => onChange({ ...params, scope: e.target.value })}
          className={selectCls}
        >
          <option value="global">Global</option>
          <option value="expert">Expert-specific</option>
        </select>
      </div>
      <div>
        <FieldLabel text="Type" hint="fieldMemoryType" />
        <select
          value={(params.type as string) ?? 'fact'}
          onChange={(e) => onChange({ ...params, type: e.target.value })}
          className={selectCls}
        >
          <option value="fact">Fact</option>
          <option value="knowledge_entry">Knowledge Entry</option>
        </select>
      </div>
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

function NotificationParams({ params, onChange, step }: PWithStep) {
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
          placeholder="e.g. Summary:&#10;&#10;{{previous_output}}"
          className={textareaCls}
        />
        <p className="mt-1 text-[11px] text-text-tertiary">
          Longer text shown under the headline. Use <code className="px-1 rounded bg-bg-base text-text-secondary">{'{{previous_output}}'}</code> to pull in data from a connected step.
        </p>
      </div>

      <AvailableVariablesSection step={step} onInsert={insertAtCursor} />

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
}: { actionType: string; step?: RoutineStepData } & P) {
  const resolved = resolveActionType(actionType);

  switch (resolved) {
    // AI
    case 'ask_ai': return <AskAiParams params={params} onChange={onChange} step={step} />;
    case 'run_expert': return <RunExpertParams params={params} onChange={onChange} />;
    case 'classify': return <ClassifyParams params={params} onChange={onChange} />;
    case 'extract': return <ExtractParams params={params} onChange={onChange} />;
    case 'summarize': return <SummarizeParams params={params} onChange={onChange} />;

    // Knowledge
    case 'search_memory': return <SearchMemoryParams params={params} onChange={onChange} />;
    case 'search_web': return <SearchWebParams params={params} onChange={onChange} />;
    case 'save_to_memory': return <SaveToMemoryParams params={params} onChange={onChange} />;

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
    case 'send_notification': return <NotificationParams params={params} onChange={onChange} step={step} />;

    default:
      return <StubParams name={ACTION_META[actionType]?.name ?? actionType} />;
  }
}

// ── Main Component ────────────────────────────────────────────

interface StepConfigPanelProps {
  node: Node;
  onUpdate: (nodeId: string, partial: Record<string, unknown>) => void;
  onClose: () => void;
}

export default function StepConfigPanel({ node, onUpdate, onClose }: StepConfigPanelProps) {
  const { t } = useTranslation();
  const d = node.data as RoutineStepData;
  const resolved = resolveActionType(d.actionType);
  const meta = ACTION_META[resolved] ?? ACTION_META[d.actionType];

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
              {d.inputMappings.map((m, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-[11px] text-text-tertiary font-mono bg-bg-base rounded px-2.5 py-1.5 border border-border-subtle"
                >
                  <span className="text-text-secondary">{m.sourceStepId}</span>
                  <span>.{m.sourceField}</span>
                  <span className="text-accent">&rarr;</span>
                  <span className="text-text-secondary">{m.targetField}</span>
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
