import { useState, useEffect } from 'react';
import { X, Shield } from 'lucide-react';
import type { Node } from '@xyflow/react';
import type { RoutineStepData } from '../../../utils/dag-flow-mapping';
import { ACTION_META } from '../../../utils/step-defaults';
import Toggle from '../../ui/Toggle';

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

function FieldLabel({ text }: { text: string }) {
  return (
    <label className="block text-[10px] font-medium text-text-tertiary uppercase tracking-wide mb-1">
      {text}
    </label>
  );
}

// ── Param Forms ───────────────────────────────────────────────

function ModelCallParams({
  params,
  onChange,
}: {
  params: Record<string, unknown>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Prompt" />
        <textarea
          value={(params.prompt as string) ?? ''}
          onChange={(e) => onChange({ ...params, prompt: e.target.value })}
          rows={4}
          placeholder="Enter prompt for the model..."
          className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none"
        />
      </div>
      <div>
        <FieldLabel text="System Prompt" />
        <textarea
          value={(params.systemPrompt as string) ?? ''}
          onChange={(e) => onChange({ ...params, systemPrompt: e.target.value })}
          rows={3}
          placeholder="Optional system prompt..."
          className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none"
        />
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <FieldLabel text="Temperature" />
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={(params.temperature as number) ?? ''}
            onChange={(e) =>
              onChange({
                ...params,
                temperature: e.target.value ? parseFloat(e.target.value) : undefined,
              })
            }
            placeholder="0.7"
            className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
          />
        </div>
        <div className="flex-1">
          <FieldLabel text="Max Tokens" />
          <input
            type="number"
            min={1}
            value={(params.maxTokens as number) ?? ''}
            onChange={(e) =>
              onChange({
                ...params,
                maxTokens: e.target.value ? parseInt(e.target.value) : undefined,
              })
            }
            placeholder="2048"
            className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
          />
        </div>
      </div>
    </div>
  );
}

function ExpertStepParams({
  params,
  onChange,
}: {
  params: Record<string, unknown>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Expert ID" />
        <input
          value={(params.expertId as string) ?? ''}
          onChange={(e) => onChange({ ...params, expertId: e.target.value })}
          placeholder="Expert identifier..."
          className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
        />
      </div>
      <div>
        <FieldLabel text="Prompt" />
        <textarea
          value={(params.prompt as string) ?? ''}
          onChange={(e) => onChange({ ...params, prompt: e.target.value })}
          rows={4}
          placeholder="Instructions for the expert..."
          className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none"
        />
      </div>
      <div>
        <FieldLabel text="Additional Context" />
        <textarea
          value={(params.additionalContext as string) ?? ''}
          onChange={(e) => onChange({ ...params, additionalContext: e.target.value })}
          rows={2}
          placeholder="Optional extra context..."
          className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none"
        />
      </div>
      <div>
        <FieldLabel text="Max Turns" />
        <input
          type="number"
          min={1}
          value={(params.maxTurns as number) ?? ''}
          onChange={(e) =>
            onChange({
              ...params,
              maxTurns: e.target.value ? parseInt(e.target.value) : undefined,
            })
          }
          placeholder="10"
          className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
        />
      </div>
    </div>
  );
}

function TransformerParams({
  params,
  onChange,
}: {
  params: Record<string, unknown>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  const operation = (params.operation as string) ?? 'format';
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Operation" />
        <select
          value={operation}
          onChange={(e) => onChange({ ...params, operation: e.target.value })}
          className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent/30 transition-colors"
        >
          <option value="format">Format</option>
          <option value="extract">Extract</option>
          <option value="filter">Filter</option>
          <option value="merge">Merge</option>
          <option value="template">Template</option>
        </select>
      </div>

      {(operation === 'format' || operation === 'template') && (
        <div>
          <FieldLabel text="Template" />
          <textarea
            value={(params.template as string) ?? ''}
            onChange={(e) => onChange({ ...params, template: e.target.value })}
            rows={4}
            placeholder={
              operation === 'format'
                ? '{{key}} interpolation...'
                : 'Mustache template...'
            }
            className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none"
          />
        </div>
      )}

      {operation === 'extract' && (
        <div>
          <FieldLabel text="Path" />
          <input
            value={(params.path as string) ?? ''}
            onChange={(e) => onChange({ ...params, path: e.target.value })}
            placeholder="data.result.text"
            className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
          />
        </div>
      )}

      {operation === 'filter' && (
        <div>
          <FieldLabel text="Predicate" />
          <input
            value={(params.predicate as string) ?? ''}
            onChange={(e) => onChange({ ...params, predicate: e.target.value })}
            placeholder="status == 'active'"
            className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
          />
        </div>
      )}

      {operation === 'merge' && (
        <div>
          <FieldLabel text="Strategy" />
          <select
            value={(params.strategy as string) ?? 'shallow'}
            onChange={(e) => onChange({ ...params, strategy: e.target.value })}
            className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent/30 transition-colors"
          >
            <option value="shallow">Shallow</option>
            <option value="deep">Deep</option>
          </select>
        </div>
      )}
    </div>
  );
}

function ApprovalGateParams({
  params,
  onChange,
}: {
  params: Record<string, unknown>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel text="Summary" />
        <textarea
          value={(params.summary as string) ?? ''}
          onChange={(e) => onChange({ ...params, summary: e.target.value })}
          rows={3}
          placeholder="Describe what the reviewer should check before approving..."
          className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none"
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

function StubParams({ type }: { type: string }) {
  return (
    <div className="rounded-lg bg-bg-base border border-border-subtle p-3">
      <p className="text-xs text-text-tertiary text-center">
        {type === 'connector' ? 'Connector' : 'Channel'} configuration coming soon.
      </p>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────

interface StepConfigPanelProps {
  node: Node;
  onUpdate: (nodeId: string, partial: Partial<RoutineStepData>) => void;
  onClose: () => void;
}

export default function StepConfigPanel({
  node,
  onUpdate,
  onClose,
}: StepConfigPanelProps) {
  const d = node.data as RoutineStepData;
  const meta = ACTION_META[d.actionType];

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

  const handleParamsChange = (params: Record<string, unknown>) => {
    onUpdate(node.id, { params });
  };

  return (
    <div className="absolute top-0 right-0 bottom-0 w-[380px] bg-bg-surface border-l border-border-subtle animate-slide-in-right z-30 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle flex-shrink-0">
        <h3 className="text-sm font-semibold text-text-primary tracking-wide">
          Step Configuration
        </h3>
        <button
          onClick={onClose}
          aria-label="Close step configuration"
          className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-5 space-y-6">
        {/* Identity */}
        <Section label="STEP IDENTITY">
          <div className="space-y-3">
            <div>
              <FieldLabel text="Name" />
              <input
                value={stepName}
                onChange={(e) => setStepName(e.target.value)}
                onBlur={handleNameBlur}
                onKeyDown={(e) =>
                  e.key === 'Enter' && (e.target as HTMLInputElement).blur()
                }
                className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
              />
            </div>
            <div>
              <FieldLabel text="Action Type" />
              <div className="flex items-center gap-2">
                {meta && (
                  <div
                    className="w-5 h-5 rounded flex items-center justify-center"
                    style={{ backgroundColor: `${meta.colorHex}20` }}
                  >
                    <meta.icon size={12} style={{ color: meta.colorHex }} />
                  </div>
                )}
                <span
                  className="text-xs font-medium"
                  style={{ color: meta?.colorHex }}
                >
                  {meta?.name ?? d.actionType}
                </span>
              </div>
            </div>
          </div>
        </Section>

        {/* Parameters */}
        <Section label="PARAMETERS">
          {d.actionType === 'model_call' && (
            <ModelCallParams params={d.params} onChange={handleParamsChange} />
          )}
          {d.actionType === 'expert_step' && (
            <ExpertStepParams params={d.params} onChange={handleParamsChange} />
          )}
          {d.actionType === 'transformer' && (
            <TransformerParams params={d.params} onChange={handleParamsChange} />
          )}
          {d.actionType === 'approval_gate' && (
            <ApprovalGateParams params={d.params} onChange={handleParamsChange} />
          )}
          {(d.actionType === 'connector' || d.actionType === 'channel') && (
            <StubParams type={d.actionType} />
          )}
        </Section>

        {/* Error Handling (hidden for approval gates) */}
        {d.actionType !== 'approval_gate' && (
          <Section label="ERROR HANDLING">
            <div className="space-y-3">
              <div>
                <FieldLabel text="On Error" />
                <select
                  value={d.onError}
                  onChange={(e) =>
                    onUpdate(node.id, {
                      onError: e.target.value as 'fail' | 'skip' | 'retry',
                    })
                  }
                  className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent/30 transition-colors"
                >
                  <option value="fail">Fail (stop routine)</option>
                  <option value="skip">Skip (continue)</option>
                  <option value="retry">Retry</option>
                </select>
              </div>

              {d.onError === 'retry' && (
                <div>
                  <FieldLabel text="Max Retries" />
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={d.maxRetries ?? 1}
                    onChange={(e) =>
                      onUpdate(node.id, {
                        maxRetries: parseInt(e.target.value) || 1,
                      })
                    }
                    className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent/30 transition-colors"
                  />
                </div>
              )}

              <div>
                <FieldLabel text="Timeout (ms)" />
                <input
                  type="number"
                  min={1000}
                  step={1000}
                  value={d.timeoutMs ?? ''}
                  onChange={(e) =>
                    onUpdate(node.id, {
                      timeoutMs: e.target.value
                        ? parseInt(e.target.value)
                        : undefined,
                    })
                  }
                  placeholder="300000"
                  className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
                />
              </div>
            </div>
          </Section>
        )}

        {/* Approval (hidden for approval gates — always on) */}
        {d.actionType !== 'approval_gate' && (
          <Section label="APPROVAL">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield size={13} className="text-amber-400" />
                <span className="text-xs text-text-secondary">
                  Require approval before execution
                </span>
              </div>
              <Toggle
                checked={d.requiresApproval}
                onChange={() =>
                  onUpdate(node.id, {
                    requiresApproval: !d.requiresApproval,
                  })
                }
              />
            </div>
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
                  <span className="text-accent">→</span>
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
