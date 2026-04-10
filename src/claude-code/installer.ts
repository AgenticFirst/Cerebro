/**
 * Cerebro subagent / skill installer.
 *
 * Materializes Cerebro experts as project-scoped Claude Code subagents
 * under <cerebro-data-dir>/.claude/agents/<slug>.md, plus the main
 * "cerebro" subagent and a small set of skills under
 * <cerebro-data-dir>/.claude/skills/<name>/SKILL.md.
 *
 * Project-scoped means: nothing is written under ~/.claude/. All paths
 * resolve under <cerebro-data-dir>, which is `app.getPath('userData')`
 * in the Electron main process. The spawned `claude` subprocess uses
 * `cwd: <cerebro-data-dir>` so Claude Code auto-discovers everything.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

// ── Path resolution ──────────────────────────────────────────────

export interface InstallerPaths {
  dataDir: string;
  claudeDir: string;
  agentsDir: string;
  skillsDir: string;
  memoryRoot: string;
  settingsPath: string;
  runtimeInfoPath: string;
  indexPath: string;
}

export function resolvePaths(dataDir: string): InstallerPaths {
  const claudeDir = path.join(dataDir, '.claude');
  return {
    dataDir,
    claudeDir,
    agentsDir: path.join(claudeDir, 'agents'),
    skillsDir: path.join(claudeDir, 'skills'),
    memoryRoot: path.join(dataDir, 'agent-memory'),
    settingsPath: path.join(claudeDir, 'settings.json'),
    runtimeInfoPath: path.join(claudeDir, 'cerebro-runtime.json'),
    indexPath: path.join(claudeDir, 'agents', '.cerebro-index.json'),
  };
}

// ── Slugification ────────────────────────────────────────────────

/** Convert an arbitrary expert name into a safe filename slug. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Deterministic 6-char hash suffix to avoid collisions across renamed experts. */
function hashSuffix(expertId: string): string {
  let h = 0;
  for (let i = 0; i < expertId.length; i++) {
    h = (h * 31 + expertId.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 6).padStart(6, '0');
}

export function expertAgentName(expertId: string, name: string): string {
  const base = slugify(name) || 'expert';
  return `${base}-${hashSuffix(expertId)}`;
}

// ── Sidecar index ────────────────────────────────────────────────

interface SidecarIndex {
  /** expertId → agentName */
  experts: Record<string, string>;
}

function readIndex(indexPath: string): SidecarIndex {
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.experts) {
      return parsed as SidecarIndex;
    }
  } catch {
    // missing or corrupt — start fresh
  }
  return { experts: {} };
}

function writeIndex(indexPath: string, index: SidecarIndex): void {
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
  cachedIndex = index;
}

// ── Settings file ────────────────────────────────────────────────

function ensureSettings(paths: InstallerPaths): void {
  fs.mkdirSync(paths.claudeDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf-8'));
  } catch {
    existing = {};
  }

  // Always point auto memory at our project-scoped directory.
  existing.autoMemoryDirectory = paths.memoryRoot;

  fs.writeFileSync(paths.settingsPath, JSON.stringify(existing, null, 2), 'utf-8');
  fs.mkdirSync(paths.memoryRoot, { recursive: true });
}

/**
 * Write the runtime info file every time the backend port changes.
 * Skill scripts read this to discover the current backend port.
 */
export function writeRuntimeInfo(dataDir: string, backendPort: number): void {
  const paths = resolvePaths(dataDir);
  fs.mkdirSync(paths.claudeDir, { recursive: true });
  const info = {
    backend_port: backendPort,
    data_dir: dataDir,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(paths.runtimeInfoPath, JSON.stringify(info, null, 2), 'utf-8');
}

// ── Agent file generation ────────────────────────────────────────

interface AgentFile {
  name: string;
  description: string;
  tools: string[];
  body: string;
}

function renderAgentFile(file: AgentFile): string {
  const frontmatter = [
    '---',
    `name: ${file.name}`,
    `description: ${escapeYaml(file.description)}`,
    `tools: ${file.tools.join(', ')}`,
    '---',
    '',
  ].join('\n');
  return frontmatter + file.body.trimEnd() + '\n';
}

function escapeYaml(s: string): string {
  // Single-line quoted form is safest for descriptions.
  const cleaned = s.replace(/\r?\n/g, ' ').trim();
  return `"${cleaned.replace(/"/g, '\\"')}"`;
}

const CEREBRO_TOOLS = [
  'Agent',
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
];

const EXPERT_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
];

function memoryInstructions(memoryDir: string): string {
  return `## Memory

Your persistent memory lives at:

\`\`\`
${memoryDir}
\`\`\`

At the start of every turn, read any markdown files in that directory using \`Read\` and \`Glob\` so you have full context. When you learn something worth remembering, append a new \`.md\` file or update an existing one with \`Write\` / \`Edit\`. Keep files small and topical (one subject per file).

Never store secrets, API keys, or anything the user shouldn't trust on disk.`;
}

function buildCerebroBody(memoryDir: string): string {
  return `You are Cerebro, the user's personal AI assistant. You coordinate a team of specialist subagents (called "experts") and manage long-lived memory about the user across conversations.

## Your role

- Hold conversations with the user about anything: work, projects, planning, ideas, day-to-day questions.
- Remember important things the user tells you so you can bring them up later.
- Delegate to specialist experts when a task is clearly in someone else's wheelhouse — that's what the \`Agent\` tool is for.
- Never reveal internal implementation details (file paths, tool names) unless the user asks.

${memoryInstructions(memoryDir)}

## Delegation

You have access to a roster of specialist experts as Claude Code subagents in the same project. Use the \`Agent\` tool to delegate when:

- The user explicitly asks for a specific expert.
- The task is clearly the specialty of one of your experts (e.g. fitness coaching → fitness coach).
- A task would benefit from a focused, dedicated context window.

When delegating, give the subagent the relevant context — don't just forward the user's literal words. Pass the question, what you already know, and what you want back.

## Skills

You have access to Cerebro-specific skills (look under \`.claude/skills/\`):

- \`create-expert\` — propose and create a new expert when the user describes a recurring need that no current expert covers. Use this instead of just suggesting "you should create an expert" — actually run the skill.
- \`list-experts\` — fetch the current roster of experts from the backend if you need to know who you can delegate to.
- \`summarize-conversation\` — used by routines.

## Style

Be direct and concrete. Don't pad responses with caveats or "as an AI" disclaimers. If you don't know something, say so and offer to look it up or ask the user. Use markdown sparingly — only when it actually helps readability.
`;
}

function buildExpertBody(systemPrompt: string, memoryDir: string): string {
  const trimmed = (systemPrompt || '').trim();
  const userBody = trimmed.length > 0
    ? trimmed
    : 'You are a Cerebro specialist subagent. Help the user with tasks in your domain.';
  return `${userBody}

---

${memoryInstructions(memoryDir)}
`;
}

// ── Skills ───────────────────────────────────────────────────────

interface SkillSpec {
  name: string;
  description: string;
  body: string;
}

function renderSkillFile(skill: SkillSpec): string {
  return [
    '---',
    `name: ${skill.name}`,
    `description: ${escapeYaml(skill.description)}`,
    '---',
    '',
    skill.body.trimEnd(),
    '',
  ].join('\n');
}

function builtinSkills(): SkillSpec[] {
  return [
    {
      name: 'summarize-conversation',
      description: 'Summarize a conversation transcript into 1-2 paragraphs of key takeaways.',
      body: `# Summarize conversation

You will receive a conversation transcript. Produce a concise summary covering:

1. The main topics discussed.
2. Any decisions, action items, or commitments.
3. Open questions left unresolved.

Keep the summary under 200 words. Plain prose, no headers.
`,
    },
    {
      name: 'list-experts',
      description: 'Fetch the current roster of Cerebro experts from the backend.',
      body: `# List experts

Run this skill to discover which Cerebro experts (subagents) currently exist. This is useful when you need to decide whether to delegate and to whom.

\`\`\`bash
PORT=$(jq -r .backend_port "$CLAUDE_PROJECT_DIR/.claude/cerebro-runtime.json")
curl -s "http://127.0.0.1:$PORT/experts?is_enabled=true&limit=200" | jq '.experts[] | {id, name, slug, description}'
\`\`\`

Report the list back to the parent conversation in compact form (name + one-line description per expert).
`,
    },
    {
      name: 'create-expert',
      description: 'Propose and create a new Cerebro expert (specialist subagent) via the backend.',
      body: `# Create expert

Use this skill when the user describes a recurring need that none of the current experts cover. **Always confirm with the user first** — show them a proposed name, description, and system prompt, get a yes, then run the script.

## Step 1: Confirm with the user

Draft a proposal in plain prose:

- **Name**: short, memorable, e.g. "Fitness Coach"
- **Description**: one sentence about what this expert does.
- **System prompt**: 2-4 paragraphs describing the expert's role, tone, and how it should behave.

Ask the user to approve, edit, or reject. Do not proceed until they say yes.

## Step 2: Create the expert

Once approved, POST to the backend. The expert will be installed as a Claude Code subagent automatically on the next sync.

\`\`\`bash
PORT=$(jq -r .backend_port "$CLAUDE_PROJECT_DIR/.claude/cerebro-runtime.json")

# Replace these with the approved values
NAME="Fitness Coach"
DESCRIPTION="Helps the user with strength training, mobility, and recovery."
SYSTEM_PROMPT="You are a fitness coach with deep experience in strength training..."

curl -s -X POST "http://127.0.0.1:$PORT/experts" \\
  -H "Content-Type: application/json" \\
  -d "$(jq -n \\
    --arg name "$NAME" \\
    --arg description "$DESCRIPTION" \\
    --arg system_prompt "$SYSTEM_PROMPT" \\
    '{name: $name, description: $description, system_prompt: $system_prompt, type: "expert", source: "user", is_enabled: true}')"
\`\`\`

## Step 3: Confirm and offer to delegate

After creation, tell the user the expert is ready and offer to delegate the original question to them.
`,
    },
  ];
}

// ── Backend fetch helper ─────────────────────────────────────────

interface ExpertData {
  id: string;
  name: string;
  slug: string | null;
  description: string;
  system_prompt: string | null;
  is_enabled: boolean;
}

async function fetchExperts(backendPort: number): Promise<ExpertData[]> {
  const result = await fetchJson<{ experts: ExpertData[] }>(
    backendPort,
    '/experts?is_enabled=true&limit=200',
  );
  return result?.experts ?? [];
}

// ── Public API ───────────────────────────────────────────────────

export interface InstallerOptions {
  /** Cerebro data directory (Electron `app.getPath('userData')`). */
  dataDir: string;
  /** Backend port (used by skill scripts and to fetch the experts list). */
  backendPort: number;
}

/**
 * Idempotent full sync. Writes:
 *  - <dataDir>/.claude/settings.json (autoMemoryDirectory)
 *  - <dataDir>/.claude/cerebro-runtime.json (port)
 *  - <dataDir>/.claude/agents/cerebro.md (main agent)
 *  - <dataDir>/.claude/agents/<slug>.md  (one per enabled expert)
 *  - <dataDir>/.claude/skills/<name>/SKILL.md
 *  - <dataDir>/.claude/agents/.cerebro-index.json (sidecar)
 *  - <dataDir>/agent-memory/<name>/ (created)
 *
 * Removes orphaned expert agent files whose expert no longer exists.
 */
export async function installAll(options: InstallerOptions): Promise<void> {
  const paths = resolvePaths(options.dataDir);
  fs.mkdirSync(paths.claudeDir, { recursive: true });
  fs.mkdirSync(paths.agentsDir, { recursive: true });
  fs.mkdirSync(paths.skillsDir, { recursive: true });
  fs.mkdirSync(paths.memoryRoot, { recursive: true });

  ensureSettings(paths);

  // Cerebro main agent
  installCerebroMainAgent(paths);

  // Skills
  for (const skill of builtinSkills()) {
    installSkill(paths, skill);
  }

  // Experts
  const experts = await fetchExperts(options.backendPort);
  const index = readIndex(paths.indexPath);
  const seen = new Set<string>();

  for (const expert of experts) {
    const agentName = expertAgentName(expert.id, expert.name);
    seen.add(agentName);
    writeExpertAgent(paths, expert, agentName);
    index.experts[expert.id] = agentName;
  }

  // Cleanup: remove agent files whose expert is gone, and stale index entries.
  const toRemoveIds: string[] = [];
  for (const [expertId, agentName] of Object.entries(index.experts)) {
    if (!seen.has(agentName)) {
      const filePath = path.join(paths.agentsDir, `${agentName}.md`);
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      toRemoveIds.push(expertId);
    }
  }
  for (const id of toRemoveIds) delete index.experts[id];

  // Belt-and-suspenders: also nuke any *.md files in agentsDir we don't recognize
  // (excluding cerebro.md and the sidecar). Catches manual deletions of the index.
  try {
    const knownNames = new Set<string>(['cerebro', ...seen]);
    for (const file of fs.readdirSync(paths.agentsDir)) {
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -3);
      if (knownNames.has(name)) continue;
      try { fs.unlinkSync(path.join(paths.agentsDir, file)); } catch { /* ignore */ }
    }
  } catch {
    /* directory missing — ignore */
  }

  writeIndex(paths.indexPath, index);
}

/** Install or update a single expert (for CRUD sync). */
export function installExpert(options: InstallerOptions, expert: ExpertData): void {
  const paths = resolvePaths(options.dataDir);
  fs.mkdirSync(paths.agentsDir, { recursive: true });
  fs.mkdirSync(paths.memoryRoot, { recursive: true });

  const index = readIndex(paths.indexPath);
  const previousName = index.experts[expert.id];
  const agentName = expertAgentName(expert.id, expert.name);

  // If name changed, remove the stale file.
  if (previousName && previousName !== agentName) {
    try { fs.unlinkSync(path.join(paths.agentsDir, `${previousName}.md`)); } catch { /* ignore */ }
  }

  writeExpertAgent(paths, expert, agentName);
  index.experts[expert.id] = agentName;
  writeIndex(paths.indexPath, index);
}

/** Remove an expert's agent file (for CRUD sync). */
export function removeExpert(options: InstallerOptions, expertId: string): void {
  const paths = resolvePaths(options.dataDir);
  const index = readIndex(paths.indexPath);
  const agentName = index.experts[expertId];
  if (!agentName) return;
  try {
    fs.unlinkSync(path.join(paths.agentsDir, `${agentName}.md`));
  } catch {
    /* ignore */
  }
  delete index.experts[expertId];
  writeIndex(paths.indexPath, index);
}

// In-memory cache of the sidecar index — refreshed on every install/remove.
let cachedIndex: SidecarIndex | null = null;

/** Resolve an expertId → agent name via the sidecar index (cached in memory). */
export function getAgentNameForExpert(dataDir: string, expertId: string): string | null {
  if (!cachedIndex) {
    const paths = resolvePaths(dataDir);
    cachedIndex = readIndex(paths.indexPath);
  }
  return cachedIndex.experts[expertId] ?? null;
}

// ── Legacy memory migration ──────────────────────────────────────

interface LegacyContextFile {
  key: string; // e.g. "profile", "style", "expert:abc123"
  content: string;
  updated_at: string;
}

interface LegacyMemoryItem {
  scope: string;       // "personal", "expert", etc.
  scope_id: string | null;
  content: string;
  created_at: string;
}

function fetchJson<T = unknown>(backendPort: number, urlPath: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${backendPort}${urlPath}`, (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function fetchContextFiles(backendPort: number): Promise<LegacyContextFile[]> {
  const result = await fetchJson<LegacyContextFile[]>(backendPort, '/memory/context-files');
  return Array.isArray(result) ? result : [];
}

async function fetchLegacyItems(backendPort: number): Promise<LegacyMemoryItem[]> {
  const result = await fetchJson<LegacyMemoryItem[]>(backendPort, '/memory/legacy-items');
  return Array.isArray(result) ? result : [];
}

/**
 * One-shot migration from legacy memory storage to per-agent memory directories.
 * Idempotent: writes a marker file in `<dataDir>/.claude/` after success and
 * short-circuits on subsequent runs.
 *
 * Two legacy sources are migrated:
 *
 * 1. ``memory:context:*`` settings rows (user-authored markdown):
 *    memory:context:profile          → <memoryRoot>/cerebro/profile.md
 *    memory:context:style            → <memoryRoot>/cerebro/style.md
 *    memory:context:expert:<id>      → <memoryRoot>/<agentName>/profile.md
 *    memory:context:routine:<id>     → <memoryRoot>/cerebro/routines/<id>.md
 *    memory:context:team:<id>        → <memoryRoot>/cerebro/teams/<id>.md
 *
 * 2. Rows in the legacy ``memory_items`` table (auto-extracted facts):
 *    scope=personal                  → <memoryRoot>/cerebro/learned-facts.md
 *    scope=expert, scope_id=<id>     → <memoryRoot>/<agentName>/learned-facts.md
 *    (everything else)               → <memoryRoot>/cerebro/learned-facts.md
 *
 *    Each row becomes a bullet line. Items grouped under the same destination
 *    file are concatenated into a single markdown document.
 *
 * Existing files at the destination are NOT overwritten — the migration only
 * fills empty slots so users who already started taking notes don't lose them.
 */
export async function migrateLegacyContextFiles(options: InstallerOptions): Promise<void> {
  const paths = resolvePaths(options.dataDir);
  const marker = path.join(paths.claudeDir, '.legacy-memory-migrated');
  if (fs.existsSync(marker)) return;

  const [files, items] = await Promise.all([
    fetchContextFiles(options.backendPort),
    fetchLegacyItems(options.backendPort),
  ]);

  const index = readIndex(paths.indexPath);

  const writeIfMissing = (slug: string, filename: string, content: string): boolean => {
    const dir = path.join(paths.memoryRoot, slug);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, filename);
    if (fs.existsSync(target)) return false;
    fs.writeFileSync(target, content, 'utf-8');
    return true;
  };

  let migrated = 0;

  // ── Context files ──
  for (const file of files) {
    const { key, content } = file;
    if (!content || !content.trim()) continue;

    if (key === 'profile' || key === 'style') {
      if (writeIfMissing('cerebro', `${key}.md`, content)) migrated++;
      continue;
    }

    if (key.startsWith('expert:')) {
      const expertId = key.slice('expert:'.length);
      const agentName = index.experts[expertId];
      if (!agentName) continue;
      if (writeIfMissing(agentName, 'profile.md', content)) migrated++;
      continue;
    }

    if (key.startsWith('routine:')) {
      const routineId = key.slice('routine:'.length);
      if (writeIfMissing(path.join('cerebro', 'routines'), `${routineId}.md`, content)) {
        migrated++;
      }
      continue;
    }

    if (key.startsWith('team:')) {
      const teamId = key.slice('team:'.length);
      if (writeIfMissing(path.join('cerebro', 'teams'), `${teamId}.md`, content)) {
        migrated++;
      }
      continue;
    }
  }

  // ── Legacy memory_items → learned-facts.md ──
  // Group items by destination slug, then write one markdown file per slug.
  const factsBySlug = new Map<string, string[]>();
  for (const item of items) {
    const content = (item.content || '').trim();
    if (!content) continue;

    let slug = 'cerebro';
    if (item.scope === 'expert' && item.scope_id) {
      const agentName = index.experts[item.scope_id];
      if (agentName) slug = agentName;
    }

    if (!factsBySlug.has(slug)) factsBySlug.set(slug, []);
    factsBySlug.get(slug)!.push(`- ${content}`);
  }

  for (const [slug, lines] of factsBySlug) {
    const body = `# Learned facts\n\nMigrated from the previous memory system. Edit or split into smaller files as you see fit.\n\n${lines.join('\n')}\n`;
    if (writeIfMissing(slug, 'learned-facts.md', body)) migrated++;
  }

  fs.mkdirSync(paths.claudeDir, { recursive: true });
  fs.writeFileSync(marker, new Date().toISOString(), 'utf-8');
  console.log(`[Cerebro] Migrated ${migrated} legacy memory file(s) into agent-memory.`);
}

// ── Internal writers ─────────────────────────────────────────────

function installCerebroMainAgent(paths: InstallerPaths): void {
  const memoryDir = path.join(paths.memoryRoot, 'cerebro');
  fs.mkdirSync(memoryDir, { recursive: true });
  const file: AgentFile = {
    name: 'cerebro',
    description: "Cerebro: the user's personal AI assistant; coordinates with specialist experts.",
    tools: CEREBRO_TOOLS,
    body: buildCerebroBody(memoryDir),
  };
  fs.writeFileSync(path.join(paths.agentsDir, 'cerebro.md'), renderAgentFile(file), 'utf-8');
}

function writeExpertAgent(
  paths: InstallerPaths,
  expert: ExpertData,
  agentName: string,
): void {
  const memoryDir = path.join(paths.memoryRoot, agentName);
  fs.mkdirSync(memoryDir, { recursive: true });
  const file: AgentFile = {
    name: agentName,
    description: expert.description || expert.name,
    tools: EXPERT_TOOLS,
    body: buildExpertBody(expert.system_prompt || '', memoryDir),
  };
  fs.writeFileSync(
    path.join(paths.agentsDir, `${agentName}.md`),
    renderAgentFile(file),
    'utf-8',
  );
}

function installSkill(paths: InstallerPaths, skill: SkillSpec): void {
  const dir = path.join(paths.skillsDir, skill.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillFile(skill), 'utf-8');
}
