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
import { expertAgentName } from '../shared/agent-name';

export { expertAgentName } from '../shared/agent-name';

// ── Path resolution ──────────────────────────────────────────────

export interface InstallerPaths {
  dataDir: string;
  claudeDir: string;
  agentsDir: string;
  skillsDir: string;
  scriptsDir: string;
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
    scriptsDir: path.join(claudeDir, 'scripts'),
    memoryRoot: path.join(dataDir, 'agent-memory'),
    settingsPath: path.join(claudeDir, 'settings.json'),
    runtimeInfoPath: path.join(claudeDir, 'cerebro-runtime.json'),
    indexPath: path.join(claudeDir, 'agents', '.cerebro-index.json'),
  };
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
 * Skill scripts read this to discover the current backend port and the
 * loopback chat-actions server (port + bearer token) when it's available.
 */
export function writeRuntimeInfo(
  dataDir: string,
  backendPort: number,
  chatActions?: { port: number; token: string },
): void {
  const paths = resolvePaths(dataDir);
  fs.mkdirSync(paths.claudeDir, { recursive: true });
  const info: Record<string, unknown> = {
    backend_port: backendPort,
    data_dir: dataDir,
    updated_at: new Date().toISOString(),
  };
  if (chatActions) {
    info.chat_actions_port = chatActions.port;
    info.chat_actions_token = chatActions.token;
  }
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

function turnProtocol(memoryDir: string): string {
  return `## Turn Protocol

At the start of every conversation turn:
1. **Read your soul** — \`Read\` the file \`SOUL.md\` in your memory directory. It defines your persona, working style, and quality standards. If it doesn't exist yet, create it.
2. **Read your memory** — \`Glob\` for \`*.md\` in your memory directory and \`Read\` any files present.
3. **Do the work** — complete the user's request.
4. **Update memory** — if you learned something about the user or made a decision worth remembering, write or update a file in your memory directory.
5. **Evolve your soul** — if the user gives feedback about your style, tone, or approach, update \`SOUL.md\` to reflect it.

${memoryInstructions(memoryDir)}`;
}

function buildCerebroBody(memoryDir: string, skillsDir: string, teamsEnabled: boolean): string {
  const teamsBlock = teamsEnabled
    ? `

Some subagents are **teams** — orchestrators that delegate to multiple member experts and synthesize their work into a single deliverable. Pick a team when the user's request spans multiple disciplines (e.g. "research and ship", "review across security/frontend/backend"). Teams take longer than a single expert but produce end-to-end artifacts. Their names usually end in "Team".`
    : '';

  return `You are **Cerebro**, the user's personal AI assistant.

${turnProtocol(memoryDir)}

## Delegation

You have access to a roster of specialist experts as Claude Code subagents in the same project. Use the \`Agent\` tool to delegate when:

- The user explicitly asks for a specific expert.
- The task is clearly the specialty of one of your experts (e.g. fitness coaching → fitness coach).
- A task would benefit from a focused, dedicated context window.

When delegating, give the subagent the relevant context — don't just forward the user's literal words. Pass the question, what you already know, and what you want back.${teamsBlock}

## Skills

You have access to Cerebro-specific skills (look under \`${skillsDir}/\`):

- \`create-task\` — kick off a one-off, goal-oriented piece of work that produces a deliverable (markdown doc, runnable code app, or both). Tasks run autonomously: clarify → plan → execute. Confirm the title and goal with the user first, then invoke.
- \`create-expert\` — create a new expert (a persistent specialist persona the user will talk to repeatedly) when the user describes a recurring need that no current expert covers. First confirm the proposed name, description, and system prompt with the user, then invoke.
- \`create-skill\` — create a new custom skill when the user wants to package a reusable capability for their experts. Confirm the name, description, and instructions with the user first.
- \`list-experts\` — fetch the current roster of experts from the backend if you need to know who you can delegate to.
- \`run-chat-action\` — invoke a connected integration action directly from this chat (HubSpot ticket, Telegram or WhatsApp message, HTTP request, desktop notification — and any future integrations the user wires up). Recognizes natural-language requests in English **and Spanish**. Always pauses for human approval before the action runs.
- \`summarize-conversation\` — used by routines.

## Integration actions

When the user asks you to do something through an external service — create a HubSpot ticket, send a Telegram or WhatsApp message, fire an HTTP request, schedule a desktop notification, or any equivalent in Spanish ("envía un mensaje a Pablo por Telegram", "crea un ticket de HubSpot sobre X", "avísame en 30 minutos", etc.) — use the \`run-chat-action\` skill. Always confirm the parameters with the user before invoking, since these actions are visible to other people. The action will pause for the user to approve in the Approvals tab — tell them that and wait for the result before replying with the outcome.

### Task vs Routine vs Expert — choose the right one

- **Task** = a card on the Kanban board, assigned to an Expert who executes it autonomously. Use \`create-task\` when the user wants something tracked, owned, and queued — not just answered in chat.
- **Routine** = same steps repeating on a schedule or trigger ("every morning…", "on every push…"). Managed in the Routines screen — never \`create-task\`.
- **Expert** = a persistent persona the user returns to ("I need a fitness coach"). Use \`create-expert\`.
- A plain question or chat → answer directly or delegate to an existing expert via the \`Agent\` tool.

If ambiguous, ask one short clarifier (e.g. "Do you want me to do this once now, or set it up to run every week?") before invoking any skill.
`;
}

function buildTeamBody(
  expert: ExpertData,
  memoryDir: string,
  agentNameById: Record<string, string>,
  memberNamesById: Record<string, string>,
): string {
  const domainLine = expert.domain ? ` Domain: ${expert.domain}.` : '';
  const strategy = (expert.strategy || 'sequential').toLowerCase();
  const members = (expert.team_members || []).slice().sort((a, b) => a.order - b.order);

  const memberLines = members.map((m, idx) => {
    const agentName = agentNameById[m.expert_id];
    const displayName = memberNamesById[m.expert_id] || m.role;
    if (!agentName) {
      return `${idx + 1}. **${displayName}** — _${m.role}_ — \`[unavailable — skip and note in your final reply]\``;
    }
    return `${idx + 1}. **${displayName}** — _${m.role}_ — invoke via Agent tool with subagent name \`${agentName}\``;
  });
  const memberBlock = memberLines.join('\n');

  let strategyBlock: string;
  if (strategy === 'parallel') {
    strategyBlock = `## Strategy — Parallel

Issue **multiple \`Agent\` tool calls in a single message** so members run concurrently. Wait for every contributor to return before invoking the synthesizer (the last member listed above). Pass each contributor the same task framing; pass the synthesizer **all** contributor outputs.`;
  } else if (strategy === 'auto') {
    strategyBlock = `## Strategy — Auto

Pick sequential or parallel based on the task. If members' work depends on prior members' outputs, run sequentially. If they tackle independent angles of the same problem, fan out in parallel. Default to sequential when unsure.`;
  } else {
    strategyBlock = `## Strategy — Sequential

Invoke members **strictly in the order listed above**, one Agent call per member. Pass each member the previous member's full output as context. Do not start a member's work until the prior member has returned.`;
  }

  const handoffBlock = `## Handoff Discipline

- Members write their full artifacts (specs, code, reports) to disk via the \`Write\` tool at \`./team-run/{member-role}.md\` (or appropriate file paths for code).
- Members return a **<500-word summary** for handoff — not the full artifact.
- The synthesizer (final member) reads the on-disk artifacts via \`Read\` before producing the final deliverable.
- Keep your own coordinator output focused on routing and synthesis — do **not** restate full member outputs in your own reply.`;

  const coordinatorPrompt = (expert.coordinator_prompt || '').trim();
  const coordinatorBlock = coordinatorPrompt ? `## Coordinator Instructions\n\n${coordinatorPrompt}` : '';

  return `You are the **${expert.name}**, a Cerebro orchestrator team.${domainLine} You do not do the work yourself — you delegate to your member experts via the \`Agent\` tool and synthesize their outputs.

## Mandatory Delegation Policy (read this before anything else)

The user explicitly chose this team rather than a single expert. The value you provide IS the multi-perspective process — your own opinion alone is not the deliverable.

**On every turn, regardless of how small or simple the user's request looks, you MUST:**

1. Invoke every member listed in the **Members** section below via the \`Agent\` tool, following the **Strategy** block (sequential or parallel).
2. Wait for each invocation's response before treating delegation as complete.
3. Synthesize the members' returned outputs into your final reply.

You may scope the work small for trivial requests — but you must still scope it small *for each member*, not skip them. A 1-paragraph user prompt becomes a 1-paragraph task per member, not a coordinator-only answer. **Skipping any member, on any turn, is a failure of this team's contract** — even if you believe you can produce a good answer alone.

${turnProtocol(memoryDir)}

## Members

${memberBlock}

${strategyBlock}

${handoffBlock}

${coordinatorBlock}
`;
}

function buildExpertBody(expert: ExpertData, memoryDir: string, skills: SkillData[] = []): string {
  const domainLine = expert.domain ? ` Domain: ${expert.domain}.` : '';
  let body = `You are **${expert.name}**, a Cerebro specialist expert.${domainLine}

${turnProtocol(memoryDir)}
`;

  if (skills.length > 0) {
    body += '\n## Skills\n\nYou have the following skills. Follow their instructions when relevant:\n\n';
    for (const skill of skills) {
      body += `### ${skill.name}\n\n${skill.instructions.trimEnd()}\n\n`;
    }
  }

  return body;
}

/** Write a file only if it doesn't already exist (atomic — no TOCTOU race). */
function seedFileIfMissing(filePath: string, content: string): void {
  try {
    fs.writeFileSync(filePath, content, { encoding: 'utf-8', flag: 'wx' });
  } catch {
    // File already exists — fine, it's owned by the agent now
  }
}

// ── Soul file ────────────────────────────────────────────────

function parsePolicies(raw: Record<string, unknown> | string[] | null): string[] {
  if (!raw) return [];
  // Already parsed by fetchJson — handle object/array directly
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([k, v]) => `${k}: ${v}`);
  }
  return [];
}

function buildSoulFile(expert: ExpertData): string {
  const sections: string[] = ['# Soul\n'];

  const identity = (expert.system_prompt || '').trim();
  if (identity) {
    sections.push(`## Identity\n\n${identity}\n`);
  }

  if (expert.domain) {
    sections.push(`## Domain\n\n${expert.domain}\n`);
  }

  sections.push(
    '## Working Style\n\n'
    + '- Be direct and actionable\n'
    + "- Adapt to the user's level of expertise\n"
    + '- Ask clarifying questions when the request is ambiguous\n',
  );

  const policies = parsePolicies(expert.policies);
  if (policies.length > 0) {
    sections.push(`## Quality Standards\n\n${policies.map((p) => `- ${p}`).join('\n')}\n`);
  }

  sections.push("## Communication\n\n(Evolve this section as you learn the user's communication preferences.)\n");

  return sections.join('\n');
}

function buildCerebroSoulFile(): string {
  return buildSoulFile({
    id: 'cerebro',
    name: 'Cerebro',
    slug: 'cerebro',
    description: "The user's personal AI assistant",
    system_prompt: 'You are Cerebro, the user\'s personal AI assistant. You coordinate a team of specialist subagents (called "experts") and manage long-lived memory about the user across conversations.',
    domain: null,
    policies: null,
    is_enabled: true,
  });
}

// ── Scripts (executable bash, guaranteed execution) ──────────────

interface ScriptSpec {
  name: string;
  content: string;
}

function builtinScripts(): ScriptSpec[] {
  return [
    {
      name: 'create-expert.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Creates a Cerebro expert via the backend API.
# Usage: bash create-expert.sh <json-file>
#   The JSON file must contain: name, description, system_prompt
#
# Example:
#   echo '{"name":"Coach","description":"Fitness coach","system_prompt":"You are..."}' > /tmp/expert.json
#   bash create-expert.sh /tmp/expert.json

RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"

if [ ! -f "$RUNTIME_JSON" ]; then
  echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2
  exit 1
fi

PORT=$(jq -r .backend_port "$RUNTIME_JSON" 2>/dev/null)
if [ -z "$PORT" ] || [ "$PORT" = "null" ]; then
  echo "ERROR: Cannot read backend_port from $RUNTIME_JSON" >&2
  exit 1
fi

JSON_FILE="\${1:-}"
if [ -z "$JSON_FILE" ] || [ ! -f "$JSON_FILE" ]; then
  echo "ERROR: Provide a path to a JSON file as the first argument" >&2
  echo "Usage: bash create-expert.sh <json-file>" >&2
  exit 1
fi

# Merge required defaults into the user-provided JSON
BODY=$(jq '. + {type: "expert", source: "user", is_enabled: true}' "$JSON_FILE")

RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://127.0.0.1:$PORT/experts" \\
  -H "Content-Type: application/json" \\
  -d "$BODY" 2>&1) || {
  echo "ERROR: Cannot connect to backend at port $PORT (is the app running?)" >&2
  exit 1
}

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')

if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
  EXPERT_NAME=$(echo "$BODY_RESPONSE" | jq -r '.name // "unknown"')
  EXPERT_ID=$(echo "$BODY_RESPONSE" | jq -r '.id // "unknown"')
  echo "SUCCESS: Created expert '$EXPERT_NAME' (id: $EXPERT_ID)"
  echo "$BODY_RESPONSE" | jq .
else
  echo "ERROR: Backend returned HTTP $HTTP_CODE" >&2
  echo "$BODY_RESPONSE" >&2
  exit 1
fi
`,
    },
    {
      name: 'list-experts.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Lists all enabled Cerebro experts from the backend API.
# Usage: bash list-experts.sh

RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"

if [ ! -f "$RUNTIME_JSON" ]; then
  echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2
  exit 1
fi

PORT=$(jq -r .backend_port "$RUNTIME_JSON" 2>/dev/null)
if [ -z "$PORT" ] || [ "$PORT" = "null" ]; then
  echo "ERROR: Cannot read backend_port from $RUNTIME_JSON" >&2
  exit 1
fi

curl -s "http://127.0.0.1:$PORT/experts?is_enabled=true&limit=200" | jq '.experts[] | {id, name, slug, description}'
`,
    },
    {
      name: 'create-skill.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Creates a Cerebro skill via the backend API.
# Usage: bash create-skill.sh <json-file>

RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"

if [ ! -f "$RUNTIME_JSON" ]; then
  echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2
  exit 1
fi

PORT=$(jq -r .backend_port "$RUNTIME_JSON" 2>/dev/null)
if [ -z "$PORT" ] || [ "$PORT" = "null" ]; then
  echo "ERROR: Cannot read backend_port from $RUNTIME_JSON" >&2
  exit 1
fi

JSON_FILE="\${1:-}"
if [ -z "$JSON_FILE" ] || [ ! -f "$JSON_FILE" ]; then
  echo "ERROR: Provide a path to a JSON file as the first argument" >&2
  echo "Usage: bash create-skill.sh <json-file>" >&2
  exit 1
fi

RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://127.0.0.1:$PORT/skills" \\
  -H "Content-Type: application/json" \\
  -d @"$JSON_FILE" 2>&1) || {
  echo "ERROR: Cannot connect to backend at port $PORT (is the app running?)" >&2
  exit 1
}

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')

if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
  SKILL_NAME=$(echo "$BODY_RESPONSE" | jq -r '.name // "unknown"')
  SKILL_ID=$(echo "$BODY_RESPONSE" | jq -r '.id // "unknown"')
  echo "SUCCESS: Created skill '$SKILL_NAME' (id: $SKILL_ID)"
  echo "$BODY_RESPONSE" | jq .
else
  echo "ERROR: Backend returned HTTP $HTTP_CODE" >&2
  echo "$BODY_RESPONSE" >&2
  exit 1
fi
`,
    },
    {
      name: 'rematerialize-experts.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Re-materializes agent files for all currently enabled experts so they
# are immediately invocable via the Agent tool in the current subprocess.
# Used after create-expert in task mode.

RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"

if [ ! -f "$RUNTIME_JSON" ]; then
  echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2
  exit 1
fi

PORT=$(jq -r .backend_port "$RUNTIME_JSON" 2>/dev/null)
if [ -z "$PORT" ] || [ "$PORT" = "null" ]; then
  echo "ERROR: Cannot read backend_port from $RUNTIME_JSON" >&2
  exit 1
fi

RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://127.0.0.1:$PORT/sync/agent-files" \\
  -H "Content-Type: application/json" 2>&1) || {
  echo "ERROR: Cannot connect to backend at port $PORT" >&2
  exit 1
}

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')

if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
  COUNT=$(echo "$BODY_RESPONSE" | jq -r '.count // 0')
  echo "SUCCESS: Rematerialized $COUNT expert agent files."
else
  echo "ERROR: Backend returned HTTP $HTTP_CODE" >&2
  echo "$BODY_RESPONSE" >&2
  exit 1
fi
`,
    },
    {
      name: 'create-task.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"

if [ ! -f "$RUNTIME_JSON" ]; then
  echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2
  exit 1
fi

PORT=$(jq -r .backend_port "$RUNTIME_JSON" 2>/dev/null)
if [ -z "$PORT" ] || [ "$PORT" = "null" ]; then
  echo "ERROR: Cannot read backend_port from $RUNTIME_JSON" >&2
  exit 1
fi

JSON_FILE="\${1:-}"
if [ -z "$JSON_FILE" ] || [ ! -f "$JSON_FILE" ]; then
  echo "ERROR: Provide a path to a JSON file as the first argument" >&2
  echo "Usage: bash create-task.sh <json-file>" >&2
  exit 1
fi

RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://127.0.0.1:$PORT/tasks" \\
  -H "Content-Type: application/json" \\
  -d @"$JSON_FILE" 2>&1) || {
  echo "ERROR: Cannot connect to backend at port $PORT (is the app running?)" >&2
  exit 1
}

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')

if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
  TASK_TITLE=$(echo "$BODY_RESPONSE" | jq -r '.title // "unknown"')
  TASK_ID=$(echo "$BODY_RESPONSE" | jq -r '.id // "unknown"')
  echo "SUCCESS: Created task '$TASK_TITLE' (id: $TASK_ID) in Backlog"
  echo "$BODY_RESPONSE" | jq .
else
  echo "ERROR: Backend returned HTTP $HTTP_CODE" >&2
  echo "$BODY_RESPONSE" >&2
  exit 1
fi
`,
    },
    {
      name: 'list-chat-actions.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Lists every chat-exposable action with current availability ("available"
# vs "not_connected") so Cerebro knows which integrations the user has
# wired up before trying to invoke one.
#
# Usage: bash list-chat-actions.sh [en|es]

RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"

if [ ! -f "$RUNTIME_JSON" ]; then
  echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2
  exit 1
fi

PORT=$(jq -r .chat_actions_port "$RUNTIME_JSON" 2>/dev/null)
TOKEN=$(jq -r .chat_actions_token "$RUNTIME_JSON" 2>/dev/null)
if [ -z "$PORT" ] || [ "$PORT" = "null" ] || [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: chat_actions_port/token missing from $RUNTIME_JSON (server not started?)" >&2
  exit 1
fi

LANG_CODE="\${1:-en}"

curl -sf "http://127.0.0.1:$PORT/chat-actions/catalog?lang=$LANG_CODE" \\
  -H "Authorization: Bearer $TOKEN" \\
  | jq '.actions'
`,
    },
    {
      name: 'run-chat-action.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Runs a single chat-triggered integration action through Cerebro's routine
# engine. Always pauses for human approval before the action executes — the
# call below blocks until the user clicks Approve or Deny in the Approvals
# tab, then prints the structured result.
#
# Usage: bash run-chat-action.sh <json-file>
#
# JSON body shape:
#   { "type": "hubspot_create_ticket",
#     "params": { "subject": "...", "content": "..." } }
#
# Exit codes:
#   0   success — action executed and returned a result
#   3   approval denied
#   4   integration not connected
#   1   any other failure (network, validation, runtime error)

RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"

if [ ! -f "$RUNTIME_JSON" ]; then
  echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2
  exit 1
fi

PORT=$(jq -r .chat_actions_port "$RUNTIME_JSON" 2>/dev/null)
TOKEN=$(jq -r .chat_actions_token "$RUNTIME_JSON" 2>/dev/null)
if [ -z "$PORT" ] || [ "$PORT" = "null" ] || [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: chat-actions server not running (no chat_actions_port/token in $RUNTIME_JSON)" >&2
  exit 1
fi

JSON_FILE="\${1:-}"
if [ -z "$JSON_FILE" ] || [ ! -f "$JSON_FILE" ]; then
  echo "ERROR: Provide a path to a JSON file as the first argument" >&2
  echo "Usage: bash run-chat-action.sh <json-file>" >&2
  exit 1
fi

# Long-poll: this curl call sits open until the user resolves the approval
# (or the underlying run reaches a terminal state). Increase max-time to 30
# minutes so a slow human reviewer doesn't trip the curl timeout.
RESPONSE=$(curl -s --max-time 1800 -w "\\n%{http_code}" \\
  -X POST "http://127.0.0.1:$PORT/chat-actions/run" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d @"$JSON_FILE" 2>&1) || {
  echo "ERROR: Cannot reach chat-actions server on port $PORT" >&2
  exit 1
}

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')

STATUS=$(echo "$BODY_RESPONSE" | jq -r '.status // ""')
SUMMARY=$(echo "$BODY_RESPONSE" | jq -r '.summary // ""')
ERROR=$(echo "$BODY_RESPONSE" | jq -r '.error // ""')

case "$STATUS" in
  succeeded)
    echo "SUCCESS: $SUMMARY"
    echo "$BODY_RESPONSE" | jq '.data // {}'
    exit 0
    ;;
  denied)
    echo "DENIED: \${ERROR:-Approval denied}"
    exit 3
    ;;
  unavailable)
    echo "NOT_CONNECTED: \${ERROR:-Integration is not connected.}"
    exit 4
    ;;
  *)
    echo "ERROR: \${ERROR:-Run did not complete successfully} (HTTP $HTTP_CODE)" >&2
    echo "$BODY_RESPONSE" >&2
    exit 1
    ;;
esac
`,
    },
  ];
}

function installScript(paths: InstallerPaths, script: ScriptSpec): void {
  const filePath = path.join(paths.scriptsDir, script.name);
  fs.writeFileSync(filePath, script.content, { encoding: 'utf-8', mode: 0o755 });
}

// ── Skills (markdown instructions that reference scripts) ────────

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
      name: 'create-skill',
      description: 'Create a new custom Cerebro skill via the backend API.',
      body: `# Create skill

This skill creates a new skill in Cerebro. You MUST run the command below using the **Bash** tool — the skill does not exist until the script prints SUCCESS.

From the conversation context, determine:
- **name** — a friendly display name (e.g. "Financial Analysis", "API Testing")
- **description** — one sentence explaining what the skill teaches an expert to do
- **category** — one of: general, engineering, content, operations, support, finance, productivity
- **instructions** — 200-400 words of markdown instructions that will be injected into the expert's system prompt

Then run this single Bash command, replacing the placeholder strings:

\`\`\`bash
jq -n \\
  --arg name "REPLACE_NAME" \\
  --arg description "REPLACE_DESCRIPTION" \\
  --arg category "REPLACE_CATEGORY" \\
  --arg instructions "REPLACE_INSTRUCTIONS" \\
  '{name: $name, description: $description, category: $category, instructions: $instructions, source: "user"}' \\
  > "$CLAUDE_PROJECT_DIR/.claude/tmp/new-skill.json" && \\
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/create-skill.sh" "$CLAUDE_PROJECT_DIR/.claude/tmp/new-skill.json"
\`\`\`

If the output says **SUCCESS**, tell the user the skill is ready — it appears in the Skills library.
If the output says **ERROR**, report the error to the user.
`,
    },
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

Run the list-experts script with the Bash tool:

\`\`\`bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/list-experts.sh"
\`\`\`

Report the list in compact form (name + one-line description per expert).
`,
    },
    {
      name: 'create-expert',
      description: 'Create a new Cerebro expert (specialist subagent) via the backend API.',
      body: `# Create expert

This skill creates a new expert. You MUST run the command below using the **Bash** tool — the expert does not exist until the script prints SUCCESS.

From the conversation context, determine:
- **name** — a friendly, human-readable display name with proper capitalization and spaces (e.g. "Fitness Coach", "Travel Planner", "Recipe Assistant"). NEVER use slugs, kebab-case, or technical identifiers.
- **description** — one sentence explaining what the expert does
- **system_prompt** — 2-4 paragraphs about the expert's role, tone, and behavior
- **domain** — a category keyword that matches the expert's area. Known domains with pre-built skills: \`fitness\`, \`engineering\`, \`content\`, \`finance\`, \`productivity\`, \`operations\`, \`support\`. When a domain is set, the backend automatically assigns all matching skills from the skills library to the new expert.

Then run this single Bash command, replacing the placeholder strings:

\`\`\`bash
jq -n \\
  --arg name "REPLACE_NAME" \\
  --arg description "REPLACE_DESCRIPTION" \\
  --arg system_prompt "REPLACE_SYSTEM_PROMPT" \\
  --arg domain "REPLACE_DOMAIN" \\
  '{name: $name, description: $description, system_prompt: $system_prompt, domain: $domain}' \\
  > "$CLAUDE_PROJECT_DIR/.claude/tmp/new-expert.json" && \\
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/create-expert.sh" "$CLAUDE_PROJECT_DIR/.claude/tmp/new-expert.json"
\`\`\`

If the output says **SUCCESS**, tell the user the expert is ready — it appears in the sidebar automatically. If you set a domain, mention that matching skills from the library were auto-assigned.
If the output says **ERROR**, report the error to the user.
`,
    },
    {
      name: 'create-task',
      description: 'Create a new Kanban task card assigned to an Expert via the backend API.',
      body: `# Create task

This skill creates a new **task** — a card on the Kanban board that can be assigned to an Expert for autonomous execution.

You should only be here after deciding the user wants a **tracked, queued piece of work** (not a recurring routine, not a new expert persona, not a quick question to answer in chat).

## How to invoke

From the conversation, determine:

- **title** — short, human-readable name for the task (3–8 words).
- **description_md** *(optional)* — markdown body with details, constraints, acceptance criteria.
- **expert_id** *(optional)* — id of an existing expert to assign. Run \`list-experts\` first to pick one.
- **priority** *(optional)* — \`low\`, \`normal\` (default), \`high\`, or \`urgent\`.
- **due_at** *(optional)* — ISO 8601 date string for the due date.
- **start_at** *(optional)* — ISO 8601 date string; the scheduler auto-starts the task at this time.

**Confirm the title with the user before invoking** (unless they explicitly said "just do it"). Then run:

\`\`\`bash
jq -n \\
  --arg title "REPLACE_TITLE" \\
  --arg description_md "REPLACE_DESCRIPTION" \\
  '{title: $title, description_md: $description_md}' \\
  > "$CLAUDE_PROJECT_DIR/.claude/tmp/new-task.json" && \\
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/create-task.sh" "$CLAUDE_PROJECT_DIR/.claude/tmp/new-task.json"
\`\`\`

To assign an expert, add \`--arg expert_id "EXPERT_ID"\` and include \`expert_id: $expert_id\` in the jq object.

If the output says **SUCCESS**, tell the user the task was created in the **Backlog** column on the Tasks board. They can drag it to "In Progress" to start the Expert, or set a start date for automatic scheduling.
If the output says **ERROR**, report the error to the user.
`,
    },
    {
      name: 'run-chat-action',
      description: 'Invoke a connected integration action (HubSpot, Telegram, WhatsApp, …) directly from chat. Always pauses for human approval.',
      body: `# Run chat action

Use this skill whenever the user asks Cerebro to **do** something through a connected integration — anything that touches an external service (HubSpot, Telegram, WhatsApp, HTTP endpoints, desktop notifications, and any future integrations like GitHub or iMessage).

The user may speak in **English or Spanish** (or mix them). Recognize natural-language intents and map them to the correct action \`type\`:

| User says (EN / ES) | Action type |
| --- | --- |
| "Create a HubSpot ticket about X" / "Crea un ticket de HubSpot sobre X" | \`hubspot_create_ticket\` |
| "Add Maria to HubSpot" / "Agrega a María a HubSpot" | \`hubspot_upsert_contact\` |
| "Send Pablo a Telegram" / "Envíale un Telegram a Pablo" | \`send_telegram_message\` |
| "Send a WhatsApp to +1…" / "Envía un WhatsApp a +1…" | \`send_whatsapp_message\` |
| "Notify me in 30 minutes" / "Avísame en 30 minutos" | \`send_notification\` |
| "GET https://… and tell me the status" | \`http_request\` |

## Workflow

1. **List what's available.** Run \`list-chat-actions\` to see the current catalog and which integrations are connected. If the action the user wants shows \`availability: "not_connected"\`, tell them which integration to wire up (point to **Connections** / **Integrations**) and stop.
2. **Gather parameters.** Inspect the action's \`inputSchema\` from the catalog and ask the user for any required fields you don't already have. Keep it conversational — don't dump JSON at them.
3. **Confirm before invoking.** Restate what you're about to do in one sentence ("I'll create a HubSpot ticket with subject _X_ and body _Y_ — confirm?"). These actions are visible to other people, so the user must agree.
4. **Invoke.** Write the request body to a tmp file and call \`run-chat-action.sh\`:

\`\`\`bash
jq -n \\
  --arg type "ACTION_TYPE" \\
  --argjson params 'PARAMS_JSON' \\
  '{type: $type, params: $params}' \\
  > "$CLAUDE_PROJECT_DIR/.claude/tmp/chat-action.json" && \\
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/run-chat-action.sh" "$CLAUDE_PROJECT_DIR/.claude/tmp/chat-action.json"
\`\`\`

5. **Tell the user the run is paused for approval.** The script blocks until the user clicks Approve or Deny in the **Approvals** tab. While you're waiting, do not start another action.

## Interpreting the result

- \`SUCCESS:\` — the action ran. Restate the outcome in natural language using the printed JSON (\`ticket_id\`, \`message_id\`, \`status\`, etc.). Reply in the user's language.
- \`DENIED:\` — the user declined. Acknowledge briefly; do not retry without new instructions.
- \`NOT_CONNECTED:\` — the integration was disconnected between catalog fetch and run. Tell the user and link to Connections.
- \`ERROR:\` — surface the error message verbatim and offer next steps.

## What this skill does NOT do

- Skip approval. Every action runs through the human approval gate by design.
- Compose multi-step workflows. Use **Routines** for anything that should run more than once.
- Read or modify the file system, run code, or call experts — pick a different tool for that.
`,
    },
  ];
}

// ── Backend fetch helper ─────────────────────────────────────────

interface TeamMemberData {
  expert_id: string;
  role: string;
  order: number;
}

interface ExpertData {
  id: string;
  name: string;
  slug: string | null;
  description: string;
  system_prompt: string | null;
  domain: string | null;
  policies: Record<string, unknown> | string[] | null;
  is_enabled: boolean;
  type?: string;
  team_members?: TeamMemberData[] | null;
  strategy?: string | null;
  coordinator_prompt?: string | null;
}

interface SkillData {
  id: string;
  name: string;
  instructions: string;
  tool_requirements: string[] | null;
}

async function fetchExperts(backendPort: number): Promise<ExpertData[]> {
  const result = await fetchJson<{ experts: ExpertData[] }>(
    backendPort,
    '/experts?is_enabled=true&limit=200',
  );
  return result?.experts ?? [];
}

async function fetchExpertSkills(
  backendPort: number,
  expertId: string,
): Promise<SkillData[]> {
  const result = await fetchJson<{
    skills: Array<{ skill: SkillData; is_active: boolean }>;
  }>(backendPort, `/experts/${expertId}/skills`);
  return (result?.skills ?? [])
    .filter((s) => s.is_active)
    .map((s) => s.skill);
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
  fs.mkdirSync(paths.scriptsDir, { recursive: true });
  // Temp dir for skill-generated files (e.g. expert JSON payloads)
  fs.mkdirSync(path.join(paths.claudeDir, 'tmp'), { recursive: true });
  fs.mkdirSync(paths.memoryRoot, { recursive: true });

  ensureSettings(paths);

  // Read the teams beta flag once — drives the Cerebro main agent prompt.
  const teamsEnabled = await fetchTeamsFlag(options.backendPort);

  // Cerebro main agent
  installCerebroMainAgent(paths, teamsEnabled);

  // Executable scripts (reliable — invoked via Bash tool)
  for (const script of builtinScripts()) {
    installScript(paths, script);
  }

  // Skills (instructions that reference the scripts above)
  for (const skill of builtinSkills()) {
    installSkill(paths, skill);
  }

  // Experts
  const experts = await fetchExperts(options.backendPort);
  const index = readIndex(paths.indexPath);
  const seen = new Set<string>();

  // Topological install: regular experts first so we can resolve member
  // references when installing teams. Teams always materialize regardless of
  // the beta flag — flipping it on shouldn't require a re-install.
  const regulars = experts.filter((e) => (e.type ?? 'expert') !== 'team');
  const teams = experts.filter((e) => e.type === 'team');

  // Fetch skills only for regular experts (teams don't carry skills).
  const regularSkillSets = await Promise.all(
    regulars.map((expert) => fetchExpertSkills(options.backendPort, expert.id)),
  );

  const agentNameById: Record<string, string> = {};
  const memberNamesById: Record<string, string> = {};

  for (let i = 0; i < regulars.length; i++) {
    const expert = regulars[i];
    const agentName = expertAgentName(expert.id, expert.name);
    seen.add(agentName);
    writeExpertAgent(paths, expert, agentName, regularSkillSets[i]);
    index.experts[expert.id] = agentName;
    agentNameById[expert.id] = agentName;
    memberNamesById[expert.id] = expert.name;
  }

  for (const team of teams) {
    const agentName = expertAgentName(team.id, team.name);
    seen.add(agentName);
    writeTeamAgent(paths, team, agentName, agentNameById, memberNamesById);
    index.experts[team.id] = agentName;
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
export async function installExpert(options: InstallerOptions, expert: ExpertData): Promise<void> {
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

  if (expert.type === 'team') {
    // Teams need member agent names resolved. Refetch the full expert list
    // so member ids resolve regardless of index freshness.
    const all = await fetchExperts(options.backendPort);
    const agentNameById: Record<string, string> = {};
    const memberNamesById: Record<string, string> = {};
    for (const e of all) {
      if ((e.type ?? 'expert') === 'team') continue;
      agentNameById[e.id] = expertAgentName(e.id, e.name);
      memberNamesById[e.id] = e.name;
    }
    writeTeamAgent(paths, expert, agentName, agentNameById, memberNamesById);
  } else {
    const skills = await fetchExpertSkills(options.backendPort, expert.id);
    writeExpertAgent(paths, expert, agentName, skills);
  }
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

function installCerebroMainAgent(paths: InstallerPaths, teamsEnabled: boolean): void {
  const memoryDir = path.join(paths.memoryRoot, 'cerebro');
  fs.mkdirSync(memoryDir, { recursive: true });
  const file: AgentFile = {
    name: 'cerebro',
    description: "Cerebro: the user's personal AI assistant; coordinates with specialist experts.",
    tools: CEREBRO_TOOLS,
    body: buildCerebroBody(memoryDir, paths.skillsDir, teamsEnabled),
  };
  fs.writeFileSync(path.join(paths.agentsDir, 'cerebro.md'), renderAgentFile(file), 'utf-8');
  seedFileIfMissing(path.join(memoryDir, 'SOUL.md'), buildCerebroSoulFile());
}

async function fetchTeamsFlag(backendPort: number): Promise<boolean> {
  const result = await fetchJson<{ key: string; value: string }>(backendPort, '/settings/beta:teams');
  if (!result || typeof result.value !== 'string') return false;
  try {
    return JSON.parse(result.value) === true;
  } catch {
    return false;
  }
}

function writeTeamAgent(
  paths: InstallerPaths,
  expert: ExpertData,
  agentName: string,
  agentNameById: Record<string, string>,
  memberNamesById: Record<string, string>,
): void {
  const memoryDir = path.join(paths.memoryRoot, agentName);
  fs.mkdirSync(memoryDir, { recursive: true });

  const file: AgentFile = {
    name: agentName,
    description: expert.description || expert.name,
    // Teams need the Agent tool to delegate to members, plus shared file tools
    // for reading on-disk handoff artifacts produced by members.
    tools: [...EXPERT_TOOLS, 'Agent'],
    body: buildTeamBody(expert, memoryDir, agentNameById, memberNamesById),
  };
  fs.writeFileSync(
    path.join(paths.agentsDir, `${agentName}.md`),
    renderAgentFile(file),
    'utf-8',
  );
  seedFileIfMissing(path.join(memoryDir, 'SOUL.md'), buildSoulFile(expert));
}

function writeExpertAgent(
  paths: InstallerPaths,
  expert: ExpertData,
  agentName: string,
  skills: SkillData[] = [],
): void {
  const memoryDir = path.join(paths.memoryRoot, agentName);
  fs.mkdirSync(memoryDir, { recursive: true });

  // Merge skill tool requirements with base expert tools
  const skillTools = skills.flatMap((s) => s.tool_requirements ?? []);
  const allTools = [...new Set([...EXPERT_TOOLS, ...skillTools])];

  const file: AgentFile = {
    name: agentName,
    description: expert.description || expert.name,
    tools: allTools,
    body: buildExpertBody(expert, memoryDir, skills),
  };
  fs.writeFileSync(
    path.join(paths.agentsDir, `${agentName}.md`),
    renderAgentFile(file),
    'utf-8',
  );
  seedFileIfMissing(path.join(memoryDir, 'SOUL.md'), buildSoulFile(expert));
}

function installSkill(paths: InstallerPaths, skill: SkillSpec): void {
  const dir = path.join(paths.skillsDir, skill.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillFile(skill), 'utf-8');
}
