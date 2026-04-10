import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Search,
  ChevronDown,
  ChevronRight,
  Save,
  Trash2,
  Plus,
  X,
  Download,
  Loader2,
  type LucideIcon,
  Code,
  FileText as FileTextIcon,
  Briefcase,
  Headphones,
  DollarSign,
  ListChecks,
  Layers,
  User,
  Dumbbell,
} from 'lucide-react';
import clsx from 'clsx';
import { useSkills } from '../../context/SkillContext';
import type { ImportedSkillData } from '../../context/SkillContext';
import { useExperts } from '../../context/ExpertContext';
import type { Skill, SkillCategory, ExpertSkillAssignment } from '../../types/skills';
import SkillIcon, { ICON_MAP } from '../ui/SkillIcon';

// ── Category config ─────────────────────────────────────────────

interface CategoryDef {
  id: SkillCategory | 'all' | 'my-skills';
  label: string;
  icon: LucideIcon;
}

const CATEGORIES: CategoryDef[] = [
  { id: 'all', label: 'All Skills', icon: Layers },
  { id: 'general', label: 'General', icon: Layers },
  { id: 'engineering', label: 'Engineering', icon: Code },
  { id: 'content', label: 'Content', icon: FileTextIcon },
  { id: 'operations', label: 'Operations', icon: Briefcase },
  { id: 'support', label: 'Support', icon: Headphones },
  { id: 'finance', label: 'Finance', icon: DollarSign },
  { id: 'fitness', label: 'Fitness', icon: Dumbbell },
  { id: 'productivity', label: 'Productivity', icon: ListChecks },
];

const SKILL_CATEGORIES = CATEGORIES.filter(
  (c) => c.id !== 'all' && c.id !== 'my-skills',
) as { id: SkillCategory; label: string; icon: LucideIcon }[];

const ICON_NAMES = Object.keys(ICON_MAP);

// ── Main Component ──────────────────────────────────────────────

export default function SkillsLibraryScreen() {
  const {
    skills,
    isLoading,
    loadSkills,
    createSkill,
    updateSkill,
    deleteSkill,
    importSkill,
    assignSkill,
    getSkillAssignments,
  } = useSkills();
  const { experts, loadExperts } = useExperts();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<CategoryDef['id']>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // Editor state (for existing skills)
  const [editDescription, setEditDescription] = useState('');
  const [editInstructions, setEditInstructions] = useState('');

  // Create state
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftCategory, setDraftCategory] = useState<SkillCategory>('general');
  const [draftIcon, setDraftIcon] = useState('sparkles');
  const [draftInstructions, setDraftInstructions] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Import state
  const [createTab, setCreateTab] = useState<'import' | 'manual'>('import');
  const [importInput, setImportInput] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [imported, setImported] = useState(false); // true = form pre-filled from import

  // Assignment state
  const [assignments, setAssignments] = useState<ExpertSkillAssignment[]>([]);
  const [showAssignDropdown, setShowAssignDropdown] = useState(false);

  useEffect(() => {
    if (skills.length === 0) loadSkills();
    if (experts.length === 0) loadExperts();
  }, [skills.length, experts.length, loadSkills, loadExperts]);

  const selectedSkill = useMemo(
    () => skills.find((s) => s.id === selectedId) ?? null,
    [skills, selectedId],
  );

  // Load skill content into editor when selection changes
  useEffect(() => {
    if (selectedSkill) {
      setEditDescription(selectedSkill.description);
      setEditInstructions(selectedSkill.instructions);
      setShowAssignDropdown(false);
    }
  }, [selectedId, selectedSkill]);

  // Load assignments for selected skill (single query, not N+1)
  const loadAssignments = useCallback(async () => {
    if (!selectedSkill) return;
    const result = await getSkillAssignments(selectedSkill.id);
    setAssignments(result);
  }, [selectedSkill, getSkillAssignments]);

  useEffect(() => {
    if (selectedSkill) loadAssignments();
  }, [selectedSkill, loadAssignments]);

  // Filter skills
  const filteredSkills = useMemo(() => {
    let result = skills;
    if (activeCategory === 'my-skills') {
      result = result.filter((s) => s.source === 'user');
    } else if (activeCategory !== 'all') {
      result = result.filter((s) => s.category === activeCategory);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
      );
    }
    return result;
  }, [skills, activeCategory, searchQuery]);

  // Group by category for left pane
  const groupedSkills = useMemo(() => {
    const groups: Record<string, Skill[]> = {};
    for (const skill of filteredSkills) {
      const cat = skill.category;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(skill);
    }
    return groups;
  }, [filteredSkills]);

  const isDirty = selectedSkill
    ? editDescription !== selectedSkill.description || editInstructions !== selectedSkill.instructions
    : false;
  const isBuiltin = selectedSkill?.source === 'builtin';

  const handleSave = async () => {
    if (!selectedSkill || !isDirty) return;
    const fields: Record<string, unknown> = {};
    if (editDescription !== selectedSkill.description) fields.description = editDescription;
    if (editInstructions !== selectedSkill.instructions) fields.instructions = editInstructions;
    await updateSkill(selectedSkill.id, fields);
  };

  const handleDelete = async () => {
    if (!selectedSkill || isBuiltin) return;
    await deleteSkill(selectedSkill.id);
    setSelectedId(null);
  };

  const handleAssign = async (expertId: string) => {
    if (!selectedSkill) return;
    await assignSkill(expertId, selectedSkill.id);
    setShowAssignDropdown(false);
    await loadAssignments();
  };

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  // ── Create flow ────────────────────────────────────────────

  const resetDraft = () => {
    setDraftName('');
    setDraftDescription('');
    setDraftCategory('general');
    setDraftIcon('sparkles');
    setDraftInstructions('');
    setImportInput('');
    setImportError(null);
    setImported(false);
  };

  const handleStartCreate = () => {
    setSelectedId(null);
    resetDraft();
    setCreateTab('import');
    setIsCreating(true);
  };

  const handleCancelCreate = () => {
    setIsCreating(false);
  };

  const applyImportData = (data: ImportedSkillData) => {
    if (data.name) setDraftName(data.name);
    if (data.description) setDraftDescription(data.description);
    if (data.instructions) setDraftInstructions(data.instructions);
    if (data.category) {
      const cat = data.category as SkillCategory;
      if (SKILL_CATEGORIES.some((c) => c.id === cat)) setDraftCategory(cat);
    }
    if (data.icon && data.icon in ICON_MAP) setDraftIcon(data.icon);
  };

  const handleImport = async () => {
    const input = importInput.trim();
    if (!input) return;
    setIsImporting(true);
    setImportError(null);
    try {
      const data = await importSkill(input);
      applyImportData(data);
      setImported(true);
      setCreateTab('manual'); // Switch to form so user can review & save
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setIsImporting(false);
    }
  };

  const handleCreate = async () => {
    if (!draftName.trim() || !draftInstructions.trim()) return;
    setIsSaving(true);
    const result = await createSkill({
      name: draftName.trim(),
      description: draftDescription.trim(),
      category: draftCategory,
      icon: draftIcon,
      instructions: draftInstructions,
      source: 'user',
    });
    setIsSaving(false);
    if (result) {
      setIsCreating(false);
      setSelectedId(result.id);
    }
  };

  const canCreate = draftName.trim().length > 0 && draftInstructions.trim().length > 0;

  const assignedExpertIds = useMemo(() => new Set(assignments.map((a) => a.expertId)), [assignments]);
  const assignableExperts = useMemo(
    () => experts.filter((e) => !assignedExpertIds.has(e.id) && e.type === 'expert'),
    [experts, assignedExpertIds],
  );

  if (isLoading && skills.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-text-tertiary">Loading skills...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* ── Left pane: skill browser ──────────────────────────── */}
      <div className="w-64 flex-shrink-0 border-r border-white/[0.06] flex flex-col">
        {/* Search + New Skill */}
        <div className="px-3 pt-4 pb-2 space-y-2">
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
            />
            <input
              type="text"
              placeholder="Search skills..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-bg-base border border-border-subtle rounded-lg pl-8 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
            />
          </div>
          <button
            onClick={handleStartCreate}
            className={clsx(
              'w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg',
              'text-[11px] font-medium text-accent',
              'bg-accent/10 hover:bg-accent/[0.18]',
              'border border-accent/20 hover:border-accent/30',
              'transition-all duration-150',
              isCreating && 'bg-accent/20 border-accent/40',
            )}
          >
            <Plus size={13} strokeWidth={2} />
            New Skill
          </button>
        </div>

        {/* Category filter tabs */}
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {[{ id: 'all', label: 'All' }, { id: 'my-skills', label: 'Mine' }].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveCategory(tab.id)}
              className={clsx(
                'px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors',
                activeCategory === tab.id
                  ? 'bg-accent/15 text-accent border border-accent/30'
                  : 'bg-bg-surface/80 text-text-tertiary border border-transparent hover:text-text-secondary hover:bg-bg-hover',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Skill list grouped by category */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-4">
          {Object.entries(groupedSkills)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([category, categorySkills]) => {
              const isCollapsed = collapsedCategories.has(category);
              const catDef = CATEGORIES.find((c) => c.id === category);
              return (
                <div key={category} className="mb-1">
                  <button
                    onClick={() => toggleCategory(category)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-white/[0.03] rounded-md transition-colors"
                  >
                    {isCollapsed ? (
                      <ChevronRight size={12} className="text-text-tertiary" />
                    ) : (
                      <ChevronDown size={12} className="text-text-tertiary" />
                    )}
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
                      {catDef?.label ?? category}
                    </span>
                    <span className="text-[10px] text-text-tertiary ml-auto">
                      {categorySkills.length}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="ml-1 space-y-px">
                      {categorySkills.map((skill) => (
                        <button
                          key={skill.id}
                          onClick={() => {
                            setIsCreating(false);
                            setSelectedId(skill.id);
                          }}
                          className={clsx(
                            'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors',
                            selectedId === skill.id && !isCreating
                              ? 'bg-accent/15 text-text-primary'
                              : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.04]',
                          )}
                        >
                          <SkillIcon
                            name={skill.icon}
                            size={12}
                            className={
                              selectedId === skill.id && !isCreating
                                ? 'text-accent'
                                : 'text-text-tertiary'
                            }
                          />
                          <span className="text-xs truncate">{skill.name}</span>
                          {skill.isDefault && (
                            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-accent/50 flex-shrink-0" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

          {filteredSkills.length === 0 && (
            <p className="text-xs text-text-tertiary px-2 py-4 text-center">
              {searchQuery ? 'No matching skills.' : 'No skills found.'}
            </p>
          )}
        </div>
      </div>

      {/* ── Right pane: skill editor / create form ──────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {isCreating ? (
          /* ── Create / Import ──────────────────────────────── */
          <div className="max-w-2xl px-8 py-8 space-y-6">
            {/* Header + close */}
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text-primary">Add Skill</h2>
              <button
                onClick={handleCancelCreate}
                className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex gap-0 border-b border-border-subtle">
              {([
                { id: 'import' as const, label: 'Import', icon: Download },
                { id: 'manual' as const, label: 'Create Manually', icon: Plus },
              ]).map((tab) => {
                const Icon = tab.icon;
                const active = createTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setCreateTab(tab.id)}
                    className={clsx(
                      'flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors',
                      active
                        ? 'text-accent border-accent'
                        : 'text-text-tertiary border-transparent hover:text-text-secondary',
                    )}
                  >
                    <Icon size={13} />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {createTab === 'import' ? (
              /* ── Import tab ──────────────────────────────────── */
              <div className="space-y-5">
                <p className="text-xs text-text-secondary leading-relaxed">
                  Import a skill from GitHub, skills.sh, or any URL that hosts a SKILL.md file.
                </p>

                {/* Input */}
                <div className="space-y-2">
                  <input
                    type="text"
                    value={importInput}
                    onChange={(e) => { setImportInput(e.target.value); setImportError(null); }}
                    onKeyDown={(e) => e.key === 'Enter' && handleImport()}
                    placeholder="Paste a URL, npx command, or owner/repo..."
                    autoFocus
                    className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
                  />
                  {importError && (
                    <p className="text-[11px] text-red-400">{importError}</p>
                  )}
                  <button
                    onClick={handleImport}
                    disabled={!importInput.trim() || isImporting}
                    className={clsx(
                      'w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-xs font-medium transition-colors',
                      importInput.trim() && !isImporting
                        ? 'bg-accent/15 text-accent hover:bg-accent/25 border border-accent/20'
                        : 'bg-bg-elevated text-text-tertiary cursor-not-allowed opacity-40 border border-transparent',
                    )}
                  >
                    {isImporting ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Download size={14} />
                    )}
                    {isImporting ? 'Fetching skill...' : 'Import'}
                  </button>
                </div>

                {/* Examples */}
                <div className="bg-bg-base rounded-lg border border-border-subtle p-4 space-y-3">
                  <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                    SUPPORTED FORMATS
                  </h4>
                  <div className="space-y-2">
                    {[
                      {
                        label: 'npx command',
                        example: 'npx skills add vercel-labs/skills --skill find-skills',
                      },
                      {
                        label: 'GitHub shorthand',
                        example: 'owner/repo@skill-name',
                      },
                      {
                        label: 'GitHub URL',
                        example: 'https://github.com/org/repo/tree/main/skills/my-skill',
                      },
                      {
                        label: 'skills.sh',
                        example: 'https://skills.sh/owner/repo/skill-name',
                      },
                      {
                        label: 'Direct URL',
                        example: 'https://raw.githubusercontent.com/.../SKILL.md',
                      },
                    ].map(({ label, example }) => (
                      <div key={label}>
                        <span className="text-[10px] font-medium text-text-tertiary">{label}</span>
                        <button
                          onClick={() => { setImportInput(example); setImportError(null); }}
                          className="block w-full text-left mt-0.5"
                        >
                          <code className="text-[11px] text-text-secondary hover:text-accent transition-colors font-mono">
                            {example}
                          </code>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              /* ── Manual / Review tab ─────────────────────────── */
              <div className="space-y-5">
                {imported && (
                  <div className="bg-accent/5 border border-accent/15 rounded-lg px-3 py-2">
                    <p className="text-[11px] text-accent">
                      Imported successfully. Review the details below and save.
                    </p>
                  </div>
                )}

                {/* Name */}
                <div>
                  <h4 className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-2">
                    NAME
                  </h4>
                  <input
                    type="text"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    placeholder="e.g. Financial Analysis, API Testing"
                    autoFocus={!imported}
                    className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
                  />
                </div>

                {/* Category + Icon row */}
                <div className="flex gap-4">
                  <div className="flex-1">
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-2">
                      CATEGORY
                    </h4>
                    <select
                      value={draftCategory}
                      onChange={(e) => setDraftCategory(e.target.value as SkillCategory)}
                      className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent/30 transition-colors"
                    >
                      {SKILL_CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="w-40">
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-2">
                      ICON
                    </h4>
                    <div className="relative">
                      <div className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                        <SkillIcon name={draftIcon} size={13} className="text-accent" />
                      </div>
                      <select
                        value={draftIcon}
                        onChange={(e) => setDraftIcon(e.target.value)}
                        className="w-full bg-bg-base border border-border-subtle rounded-lg pl-8 pr-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent/30 transition-colors"
                      >
                        {ICON_NAMES.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* Description */}
                <div>
                  <h4 className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-2">
                    DESCRIPTION
                  </h4>
                  <textarea
                    value={draftDescription}
                    onChange={(e) => setDraftDescription(e.target.value)}
                    placeholder="One sentence explaining what this skill teaches an expert to do."
                    rows={2}
                    className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary leading-relaxed placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none"
                  />
                </div>

                {/* Instructions */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-accent">
                      INSTRUCTIONS
                    </h4>
                    <span className="text-[10px] text-text-tertiary">
                      Markdown supported
                    </span>
                  </div>
                  <textarea
                    value={draftInstructions}
                    onChange={(e) => setDraftInstructions(e.target.value)}
                    placeholder="Write or paste the skill instructions here. This markdown gets injected into the expert's system prompt when this skill is assigned."
                    rows={16}
                    className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary font-mono leading-relaxed placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none"
                  />
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3 pt-2 border-t border-border-subtle">
                  <button
                    onClick={handleCreate}
                    disabled={!canCreate || isSaving}
                    className={clsx(
                      'flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium transition-colors',
                      canCreate && !isSaving
                        ? 'bg-accent/15 text-accent hover:bg-accent/25'
                        : 'bg-bg-elevated text-text-tertiary cursor-not-allowed opacity-40',
                    )}
                  >
                    <Save size={13} />
                    {isSaving ? 'Creating...' : 'Create Skill'}
                  </button>
                  <button
                    onClick={handleCancelCreate}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : selectedSkill ? (
          /* ── Existing skill editor ─────────────────────────── */
          <div className="max-w-2xl px-8 py-8 space-y-6">
            {/* Header */}
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center flex-shrink-0">
                <SkillIcon name={selectedSkill.icon} size={20} className="text-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-semibold text-text-primary">
                  {selectedSkill.name}
                </h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-accent bg-accent/10 px-2 py-0.5 rounded">
                    {selectedSkill.category}
                  </span>
                  <span className="text-[10px] text-text-tertiary">
                    {selectedSkill.source} · v{selectedSkill.version}
                  </span>
                  {selectedSkill.isDefault && (
                    <span className="text-[10px] text-text-tertiary bg-bg-elevated px-1.5 py-0.5 rounded">
                      default
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Description */}
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-2">
                DESCRIPTION
              </h4>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                readOnly={isBuiltin}
                rows={2}
                className={clsx(
                  'w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary leading-relaxed placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none',
                  isBuiltin && 'opacity-70 cursor-default',
                )}
              />
            </div>

            {/* Instructions */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-accent">
                  INSTRUCTIONS
                </h4>
                {isBuiltin && (
                  <span className="text-[10px] text-text-tertiary">Built-in — read only</span>
                )}
              </div>
              <textarea
                value={editInstructions}
                onChange={(e) => setEditInstructions(e.target.value)}
                readOnly={isBuiltin}
                rows={16}
                className={clsx(
                  'w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary font-mono leading-relaxed placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none',
                  isBuiltin && 'opacity-70 cursor-default',
                )}
              />
            </div>

            {/* Tools */}
            {selectedSkill.toolRequirements && selectedSkill.toolRequirements.length > 0 && (
              <div>
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-2">
                  TOOLS
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {selectedSkill.toolRequirements.map((tool) => (
                    <span
                      key={tool}
                      className="text-[10px] font-mono text-text-secondary bg-bg-base border border-border-subtle px-2 py-1 rounded"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Assigned to */}
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-2">
                ASSIGNED TO
              </h4>
              {assignments.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {assignments.map((a) => {
                    const expert = experts.find((e) => e.id === a.expertId);
                    return (
                      <span
                        key={a.id}
                        className="text-[11px] text-text-secondary bg-bg-base border border-border-subtle px-2 py-1 rounded-lg"
                      >
                        {expert?.name ?? a.expertId}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-text-tertiary mb-2">Not assigned to any experts.</p>
              )}

              {/* Assign dropdown */}
              {showAssignDropdown ? (
                <div className="bg-bg-base rounded-lg border border-border-subtle max-h-36 overflow-y-auto scrollbar-thin">
                  {assignableExperts.length === 0 ? (
                    <p className="text-xs text-text-tertiary px-3 py-2.5">
                      All experts already have this skill.
                    </p>
                  ) : (
                    assignableExperts.map((expert) => (
                      <button
                        key={expert.id}
                        onClick={() => handleAssign(expert.id)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-bg-hover transition-colors"
                      >
                        <User size={12} className="text-accent flex-shrink-0" />
                        <span className="text-xs text-text-secondary truncate">
                          {expert.name}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              ) : (
                <button
                  onClick={() => setShowAssignDropdown(true)}
                  className="flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover transition-colors"
                >
                  <Plus size={13} />
                  Assign to Expert
                </button>
              )}
            </div>

            {/* Footer actions */}
            <div className="flex items-center gap-3 pt-2 border-t border-border-subtle">
              {!isBuiltin && (
                <>
                  <button
                    onClick={handleSave}
                    disabled={!isDirty}
                    className={clsx(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                      isDirty
                        ? 'bg-accent/15 text-accent hover:bg-accent/25'
                        : 'bg-bg-elevated text-text-tertiary cursor-not-allowed opacity-40',
                    )}
                  >
                    <Save size={13} />
                    Save
                  </button>
                  <button
                    onClick={handleDelete}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-400/70 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                  >
                    <Trash2 size={13} />
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          /* ── Empty state ───────────────────────────────────── */
          <div className="flex-1 flex flex-col items-center justify-center py-20">
            <div className="w-16 h-16 rounded-xl border-2 border-dashed border-border-default flex items-center justify-center mb-4">
              <SkillIcon name="sparkles" size={24} className="text-text-tertiary" />
            </div>
            <h3 className="text-sm font-medium text-text-primary mb-1.5">Skills Library</h3>
            <p className="text-xs text-text-secondary mb-4 max-w-[280px] text-center">
              Skills are reusable capabilities you can assign to experts. Select a skill or add a new one.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { handleStartCreate(); setCreateTab('import'); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 border border-accent/20 transition-colors"
              >
                <Download size={13} />
                Import Skill
              </button>
              <span className="text-[10px] text-text-tertiary">or</span>
              <button
                onClick={() => { handleStartCreate(); setCreateTab('manual'); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-white/[0.04] border border-border-subtle transition-colors"
              >
                <Plus size={13} />
                Create Manually
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
