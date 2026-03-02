/**
 * Expert-scoped memory viewer.
 * Shows context file, learned facts, and knowledge entries scoped to an expert.
 */

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { Expert } from '../../context/ExpertContext';
import type { BackendResponse } from '../../types/ipc';

interface MemoryItem {
  id: string;
  content: string;
  created_at: string;
}

interface KnowledgeEntry {
  id: string;
  entry_type: string;
  summary: string;
  occurred_at: string;
}

interface ExpertMemoryTabProps {
  expert: Expert;
}

export default function ExpertMemoryTab({ expert }: ExpertMemoryTabProps) {
  const [contextContent, setContextContent] = useState('');
  const [facts, setFacts] = useState<MemoryItem[]>([]);
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadMemory = useCallback(async () => {
    setIsLoading(true);
    try {
      // Load context file
      const ctxRes: BackendResponse<{ content: string }> = await window.cerebro.invoke({
        method: 'GET',
        path: `/memory/context-files/expert:${expert.id}`,
      });
      if (ctxRes.ok) {
        setContextContent(ctxRes.data.content);
      } else {
        setContextContent('');
      }

      // Load learned facts
      const factsRes: BackendResponse<{ items: MemoryItem[]; total: number }> =
        await window.cerebro.invoke({
          method: 'GET',
          path: `/memory/items?scope=expert&scope_id=${expert.id}&limit=20`,
        });
      if (factsRes.ok) {
        setFacts(factsRes.data.items);
      }

      // Load knowledge entries
      const entriesRes: BackendResponse<{ entries: KnowledgeEntry[]; total: number }> =
        await window.cerebro.invoke({
          method: 'GET',
          path: `/memory/knowledge?scope=expert&scope_id=${expert.id}&limit=20`,
        });
      if (entriesRes.ok) {
        setEntries(entriesRes.data.entries);
      }
    } catch {
      // Non-critical
    } finally {
      setIsLoading(false);
    }
  }, [expert.id]);

  useEffect(() => {
    loadMemory();
  }, [loadMemory]);

  const deleteFact = async (id: string) => {
    await window.cerebro.invoke({ method: 'DELETE', path: `/memory/items/${id}` });
    setFacts((prev) => prev.filter((f) => f.id !== id));
  };

  const deleteEntry = async (id: string) => {
    await window.cerebro.invoke({ method: 'DELETE', path: `/memory/knowledge/${id}` });
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
          Expert Memory
        </span>
        <button
          onClick={loadMemory}
          disabled={isLoading}
          className="p-1 text-text-tertiary hover:text-text-secondary transition-colors"
        >
          <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Context file */}
      {contextContent && (
        <div>
          <div className="text-[10px] font-medium text-text-tertiary uppercase tracking-wide mb-1.5">
            Context File
          </div>
          <div className="bg-bg-base border border-border-subtle rounded-lg p-3 text-xs text-text-secondary leading-relaxed max-h-24 overflow-y-auto">
            {contextContent}
          </div>
        </div>
      )}

      {/* Learned facts */}
      <div>
        <div className="text-[10px] font-medium text-text-tertiary uppercase tracking-wide mb-1.5">
          Learned Facts ({facts.length})
        </div>
        {facts.length === 0 ? (
          <p className="text-xs text-text-tertiary">No facts learned yet.</p>
        ) : (
          <div className="space-y-1">
            {facts.map((fact) => (
              <div
                key={fact.id}
                className="flex items-start gap-2 bg-bg-base rounded-lg px-2.5 py-1.5 border border-border-subtle group"
              >
                <span className="text-xs text-text-secondary flex-1 leading-relaxed">
                  {fact.content}
                </span>
                <button
                  onClick={() => deleteFact(fact.id)}
                  className="p-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all flex-shrink-0"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Knowledge entries */}
      <div>
        <div className="text-[10px] font-medium text-text-tertiary uppercase tracking-wide mb-1.5">
          Knowledge ({entries.length})
        </div>
        {entries.length === 0 ? (
          <p className="text-xs text-text-tertiary">No knowledge entries yet.</p>
        ) : (
          <div className="space-y-1">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-start gap-2 bg-bg-base rounded-lg px-2.5 py-1.5 border border-border-subtle group"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-text-secondary truncate">{entry.summary}</div>
                  <div className="text-[10px] text-text-tertiary capitalize">
                    {entry.entry_type}
                  </div>
                </div>
                <button
                  onClick={() => deleteEntry(entry.id)}
                  className="p-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all flex-shrink-0"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
