import { useEffect } from 'react';
import { useMemory } from '../../../context/MemoryContext';
import ContextFileCard from './ContextFileCard';
import MemoryItemsList from './MemoryItemsList';
import KnowledgeEntriesList from './KnowledgeEntriesList';

const CONTEXT_FILES = [
  {
    key: 'profile',
    title: 'Profile',
    description:
      'Tell Cerebro about yourself \u2014 your name, role, interests, and anything you want it to always know.',
    placeholder: `<!-- Tell Cerebro about yourself -->\n<!-- Examples: -->\n<!-- - I'm a software engineer at Acme Corp -->\n<!-- - I'm training for the Boston Marathon in April 2026 -->\n<!-- - I prefer detailed explanations with examples -->`,
  },
  {
    key: 'style',
    title: 'Style',
    description:
      'Define how you want Cerebro to communicate \u2014 tone, format, length, preferences.',
    placeholder: `<!-- Communication preferences -->\n<!-- Examples: -->\n<!-- - Be concise and direct -->\n<!-- - Use bullet points when listing options -->\n<!-- - Avoid emojis unless I use them first -->`,
  },
];

export default function MemorySection() {
  const { loadContextFiles, loadMemoryItems, loadKnowledgeEntries, totalMemoryItems, totalKnowledgeEntries } = useMemory();

  useEffect(() => {
    loadContextFiles();
    loadMemoryItems();
    loadKnowledgeEntries();
  }, [loadContextFiles, loadMemoryItems, loadKnowledgeEntries]);

  return (
    <div className="space-y-10">
      {/* Header */}
      <div>
        <h2 className="text-lg font-medium text-text-primary mb-1">Memory</h2>
        <p className="text-sm text-text-secondary">
          Manage what Cerebro knows about you. Context files are user-authored, learned facts and
          knowledge entries are auto-extracted from conversations.
        </p>
      </div>

      {/* Tier 1: Context Files */}
      <div>
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-text-tertiary mb-4">
          Context Files
        </h3>
        <div className="space-y-3">
          {CONTEXT_FILES.map((cf) => (
            <ContextFileCard
              key={cf.key}
              fileKey={cf.key}
              title={cf.title}
              description={cf.description}
              placeholder={cf.placeholder}
            />
          ))}
        </div>
      </div>

      {/* Tier 2: Learned Facts */}
      <div>
        <div className="flex items-baseline justify-between mb-4">
          <h3 className="text-[13px] font-semibold uppercase tracking-wide text-text-tertiary">
            Learned Facts
          </h3>
          {totalMemoryItems > 0 && (
            <span className="text-xs text-text-tertiary">{totalMemoryItems} items</span>
          )}
        </div>
        <MemoryItemsList />
      </div>

      {/* Tier 3: Knowledge Entries */}
      <div>
        <div className="flex items-baseline justify-between mb-4">
          <h3 className="text-[13px] font-semibold uppercase tracking-wide text-text-tertiary">
            Knowledge Entries
          </h3>
          {totalKnowledgeEntries > 0 && (
            <span className="text-xs text-text-tertiary">{totalKnowledgeEntries} entries</span>
          )}
        </div>
        <KnowledgeEntriesList />
      </div>
    </div>
  );
}
