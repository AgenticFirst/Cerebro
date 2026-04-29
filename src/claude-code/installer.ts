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

Some subagents are **teams** — orchestrators that delegate to multiple member experts and synthesize their work into a single deliverable. Pick a team when the user's request spans multiple disciplines (e.g. "research and ship", "review across security/frontend/backend"). Teams take longer than a single expert but produce end-to-end artifacts. Their names usually end in "Team".

**Before invoking any team via the Agent tool, you MUST first announce it so the user can see who is working** — without this, the user stares at a blank screen for the entire (potentially multi-minute) run. Use \`list-experts\` (or your existing knowledge of the team) to discover the team's id, name, strategy, and member list, then run:

\`\`\`
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/announce-team-run.sh" <team_id> "<team_name>" "<strategy>" '<members_json>'
\`\`\`

Where \`<members_json>\` is a JSON array like \`[{"member_id":"abc123","member_name":"Running Coach","role":"coach"}, ...]\`. Then proceed with the \`Agent\` tool call. The team coordinator will emit per-member status updates on its own.`
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
- \`run-chat-action\` — invoke a connected integration action directly from this chat (HubSpot ticket, Telegram or WhatsApp **text or media** — photos, documents, audio, voice notes, video, stickers, location pins — GitHub issue/PR/comment/review, HTTP request, desktop notification — and any future integrations the user wires up). Recognizes natural-language requests in English **and Spanish**. Always pauses for human approval before the action runs.
- \`connect-integration\` — when the user asks to **set up, connect, or link** an external service (Telegram, HubSpot, WhatsApp, GoHighLevel, GitHub, …), open the inline setup card so they can complete the walkthrough without leaving chat. Never ask for tokens in chat — the card collects them securely.
- \`propose-routine\` — when the user describes recurring or triggered work ("every Monday…", "when a Telegram arrives…", "when a new GitHub issue opens…", "crea una rutina que…"), draft a routine, confirm it with them, dry-run it end-to-end with side-effects stubbed, and save only if every step passes. Tell the user the dry-run can take a couple of minutes.
- \`summarize-conversation\` — used by routines.

## Integration actions

When the user asks you to do something through an external service — create a HubSpot ticket, send a Telegram or WhatsApp message **or media** (photo, document, voice note, video, sticker, location), open a GitHub issue, comment on a PR, submit a PR review, fire an HTTP request, schedule a desktop notification, or any equivalent in Spanish ("envía un mensaje a Pablo por Telegram", "envíale a Maria la foto por WhatsApp", "mándale el manual en PDF", "avísame en 30 minutos", "abre un issue en GitHub", "revisa el PR #42", etc.) — use the \`run-chat-action\` skill. Always confirm the parameters with the user before invoking, since these actions are visible to other people. The action will pause for the user to approve in the Approvals tab — tell them that and wait for the result before replying with the outcome.

When sending media, prefer \`file_item_id\` (referencing a file Cerebro already has — e.g., one a previous step generated and registered). Use \`file_path\` only as an escape hatch for an absolute path Cerebro just wrote to disk.

## Connecting integrations

When the user asks to **set up, connect, or link** an integration ("set up Telegram", "connect HubSpot", "configura WhatsApp", "conecta GoHighLevel", "connect GitHub", etc.), use the \`connect-integration\` skill. It opens an inline IntegrationSetupCard with the provider's walkthrough (BotFather for Telegram, Private App for HubSpot, QR pairing for WhatsApp, Private Integration API key for GoHighLevel, Personal Access Token for GitHub). Don't paste setup instructions into chat or ask for tokens — the card handles both. Currently supported integrations: \`telegram\`, \`hubspot\`, \`whatsapp\`, \`ghl\`, \`github\`. Anything else — Slack, Gmail, Notion, Calendar, etc. — is on the roadmap; tell the user and stop.

### Task vs Routine vs Expert — choose the right one

- **Task** = a card on the Kanban board, assigned to an Expert who executes it autonomously. Use \`create-task\` when the user wants something tracked, owned, and queued — not just answered in chat.
- **Routine** = same steps repeating on a schedule or trigger ("every morning…", "on every push…", "cada lunes…"). Use the \`propose-routine\` skill, which always proposes first → confirms with the user → dry-runs end-to-end (a couple of minutes) → saves only on a clean test.
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
      return `${idx + 1}. **${displayName}** — _${m.role}_ — member_id=\`${m.expert_id}\` — \`[unavailable — skip and note in your final reply]\``;
    }
    return `${idx + 1}. **${displayName}** — _${m.role}_ — member_id=\`${m.expert_id}\` — invoke via Agent tool with subagent name \`${agentName}\``;
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

The depth of this run is driven by a \`[QUALITY_TIER=fast|medium|slow]\` marker that Cerebro prepends to the prompt it sends you (look at the first line). When the marker is absent, treat it as \`medium\`.

**\`[QUALITY_TIER=slow]\`** — the user wants depth and is willing to wait:
- Each member writes their full artifact to disk at \`./team-run/{member-role}.md\` (or appropriate file paths for code) AND returns the FULL artifact text inline to you (no word cap).
- Before composing the final deliverable, you MUST \`Read\` every member's artifact file and confirm the inline text matches.
- Preserve day-by-day detail, embedded links (instructional videos, illustrated guides, references), and per-section depth from the members. Do not condense.
- When concrete reference media (instructional videos, illustrated guides, links) would help the user, include them in the artifact.
- The final deliverable MUST be at least as long as the longest individual member artifact.

**\`[QUALITY_TIER=medium]\`** (default) — balanced depth:
- Members write their full artifacts to disk AND return a **<500-word handoff summary**.
- Before composing the final deliverable, you MUST \`Read\` every member's artifact via the \`Read\` tool. Synthesizing from the 500-word summaries alone is a contract violation — full detail lives in the on-disk files.

**\`[QUALITY_TIER=fast]\`** — the user wants speed:
- Cap the team to the first 2 members listed in **Members**; skip the rest.
- Members return inline summaries only — no disk writes required.
- Synthesize quickly; concise output is fine.

## Live status reporting

Cerebro is showing the user a live status card listing every member with a queued/running/completed indicator. You MUST emit per-member status updates so the card stays current — without these calls the user sees a frozen card for the entire run.

- **At each member's start** (right before invoking the \`Agent\` tool for that member), run:
  \`\`\`
  bash "$CLAUDE_PROJECT_DIR/.claude/scripts/team-member-update.sh" <team_id> <member_id> running
  \`\`\`
- **At each member's completion** (right after the Agent tool returns):
  \`\`\`
  bash "$CLAUDE_PROJECT_DIR/.claude/scripts/team-member-update.sh" <team_id> <member_id> completed
  \`\`\`
- **If a member fails**, pass \`error\` plus a one-line message as a fourth argument:
  \`\`\`
  bash "$CLAUDE_PROJECT_DIR/.claude/scripts/team-member-update.sh" <team_id> <member_id> error "Brief reason"
  \`\`\`

The \`<team_id>\` is your team_id (\`${expert.id}\`) shown at the top of this prompt. The \`<member_id>\` is the \`member_id\` value listed for each entry in **Members** below.

Keep your own coordinator output focused on routing and synthesis — do **not** restate full member outputs in your own reply (they will be surfaced separately).`;

  const coordinatorPrompt = (expert.coordinator_prompt || '').trim();
  const coordinatorBlock = coordinatorPrompt ? `## Coordinator Instructions\n\n${coordinatorPrompt}` : '';

  return `You are the **${expert.name}**, a Cerebro orchestrator team.${domainLine} You do not do the work yourself — you delegate to your member experts via the \`Agent\` tool and synthesize their outputs.

Your **team_id** is \`${expert.id}\`. Use this verbatim when calling \`team-member-update.sh\` (see "Live status reporting" below).

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

/** Per-file cap on injected context (chars). Reference docs ride EVERY chat
 * turn's system prompt, so we cap lower than the per-attachment cap on
 * one-shot uploads (60k) to keep total context predictable. */
const MAX_CONTEXT_FILE_CHARS_PER_FILE = 40_000;
/** Aggregate cap across all reference docs for one expert. */
const MAX_CONTEXT_FILE_TOTAL_CHARS = 120_000;

function renderExpertContextSection(
  contextFiles: ContextFileData[] = [],
): string {
  if (contextFiles.length === 0) return '';

  const blocks: string[] = [];
  let totalChars = 0;
  for (const cf of contextFiles) {
    let body = '';
    let footer = '';
    if (cf.parsed_text_path && fs.existsSync(cf.parsed_text_path)) {
      try {
        body = fs.readFileSync(cf.parsed_text_path, 'utf-8');
      } catch {
        body = '';
      }
    }
    if (!body) {
      // Image / text-passthrough / parse-failed: surface the file path so the
      // expert can Read it on its own (safe for images and plain text).
      body = `(File preserved at \`${cf.file_storage_path}\`. Use the Read tool only for text/image formats — never on binary office docs.)`;
    } else {
      if (body.length > MAX_CONTEXT_FILE_CHARS_PER_FILE) {
        body = body.slice(0, MAX_CONTEXT_FILE_CHARS_PER_FILE)
          + `\n\n[truncated — original was ${body.length} chars; raise expert.token_budget or split the file]`;
      }
      if (totalChars + body.length > MAX_CONTEXT_FILE_TOTAL_CHARS) {
        footer = `\n\n[remaining reference files omitted — aggregate context cap of ${MAX_CONTEXT_FILE_TOTAL_CHARS} chars reached]`;
        blocks.push(footer);
        break;
      }
      totalChars += body.length;
    }
    const kindLabel = cf.kind === 'template' ? ' (TEMPLATE — always follow this format)' : '';
    blocks.push(`### ${cf.file_name}${kindLabel}\n\n${body.trim()}`);
  }

  return (
    '\n## Reference documents\n\n'
    + 'These files were attached by the user as permanent reference for every turn. '
    + 'Use them as authoritative context. When a file is marked TEMPLATE, your output MUST follow its structure (headings, sections, formatting) exactly.\n\n'
    + blocks.join('\n\n')
    + '\n'
  );
}

function buildExpertBody(
  expert: ExpertData,
  memoryDir: string,
  skills: SkillData[] = [],
  contextFiles: ContextFileData[] = [],
): string {
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

  body += renderExpertContextSection(contextFiles);

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
      name: 'dry-run-routine.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Tests a candidate routine end-to-end with side-effects stubbed so we can
# tell the user "it works" before persisting. Long-poll: blocks until the
# engine completes the dry-run (a couple of minutes on a heavy routine).
#
# Usage: bash dry-run-routine.sh <json-file>
#   JSON body: { "dag": { "steps": [...] }, "trigger_payload"?: {...} }
#
# Exit codes:
#   0 — dry-run completed (caller MUST inspect .ok in the body)
#   1 — transport / validation error before the run started

RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"

if [ ! -f "$RUNTIME_JSON" ]; then
  echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2
  exit 1
fi

PORT=$(jq -r .chat_actions_port "$RUNTIME_JSON" 2>/dev/null)
TOKEN=$(jq -r .chat_actions_token "$RUNTIME_JSON" 2>/dev/null)
if [ -z "$PORT" ] || [ "$PORT" = "null" ] || [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: chat-actions server not running" >&2
  exit 1
fi

JSON_FILE="\${1:-}"
if [ -z "$JSON_FILE" ] || [ ! -f "$JSON_FILE" ]; then
  echo "ERROR: Provide a path to a JSON file as the first argument" >&2
  exit 1
fi

curl -sf --max-time 600 \\
  -X POST "http://127.0.0.1:$PORT/chat-actions/dry-run-routine" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d @"$JSON_FILE"
`,
    },
    {
      name: 'save-routine.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Persists a routine via the backend API. Use this AFTER dry-run-routine.sh
# has returned ok=true.
#
# Usage: bash save-routine.sh <json-file>
#   JSON body matches POST /routines: { name, description?, plain_english_steps?,
#                                       dag_json (string), trigger_type, ... }

RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"

if [ ! -f "$RUNTIME_JSON" ]; then
  echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2
  exit 1
fi

PORT=$(jq -r .backend_port "$RUNTIME_JSON" 2>/dev/null)
if [ -z "$PORT" ] || [ "$PORT" = "null" ]; then
  echo "ERROR: backend not running" >&2
  exit 1
fi

JSON_FILE="\${1:-}"
if [ -z "$JSON_FILE" ] || [ ! -f "$JSON_FILE" ]; then
  echo "ERROR: Provide a path to a JSON file as the first argument" >&2
  exit 1
fi

RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://127.0.0.1:$PORT/routines" \\
  -H "Content-Type: application/json" \\
  -d @"$JSON_FILE" 2>&1) || {
  echo "ERROR: Cannot connect to backend at port $PORT" >&2
  exit 1
}

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')

if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
  ROUTINE_NAME=$(echo "$BODY_RESPONSE" | jq -r '.name // "unknown"')
  ROUTINE_ID=$(echo "$BODY_RESPONSE" | jq -r '.id // "unknown"')
  echo "SUCCESS: Saved routine '$ROUTINE_NAME' (id: $ROUTINE_ID)"
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
    {
      name: 'propose-integration.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Asks the Cerebro UI to render an inline IntegrationSetupCard so the user
# can connect an integration (Telegram, HubSpot, WhatsApp, GoHighLevel, …)
# without leaving chat. The renderer owns credential entry — this script
# never transmits secrets and the chat agent must not ask for tokens in chat.
#
# Usage: bash propose-integration.sh <integration_id> [reason]
#
# integration_id must match a manifest in src/integrations/registry.ts.
# Currently: telegram | hubspot | whatsapp | ghl | github.

RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"

if [ ! -f "$RUNTIME_JSON" ]; then
  echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2
  exit 1
fi

PORT=$(jq -r .chat_actions_port "$RUNTIME_JSON" 2>/dev/null)
TOKEN=$(jq -r .chat_actions_token "$RUNTIME_JSON" 2>/dev/null)
if [ -z "$PORT" ] || [ "$PORT" = "null" ] || [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: chat-actions server not running" >&2
  exit 1
fi

INTEGRATION_ID="\${1:-}"
if [ -z "$INTEGRATION_ID" ]; then
  echo "ERROR: integration_id is required (e.g. telegram, hubspot, whatsapp, ghl, github)" >&2
  exit 1
fi
REASON="\${2:-}"

BODY=$(jq -n \\
  --arg integration_id "$INTEGRATION_ID" \\
  --arg reason "$REASON" \\
  '{integration_id: $integration_id} + (if $reason == "" then {} else {reason: $reason} end)')

RESPONSE=$(curl -s -w "\\n%{http_code}" \\
  -X POST "http://127.0.0.1:$PORT/chat-actions/propose-integration" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d "$BODY") || {
  echo "ERROR: Cannot reach chat-actions server on port $PORT" >&2
  exit 1
}

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "SUCCESS: Setup card opened for $INTEGRATION_ID"
  exit 0
fi
ERROR=$(echo "$BODY_RESPONSE" | jq -r '.error // ""')
echo "ERROR: \${ERROR:-Could not open setup card} (HTTP $HTTP_CODE)" >&2
exit 1
`,
    },
    {
      name: 'announce-team-run.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Pre-populates the live TeamRunCard in the chat UI with the team and its
# members in 'queued' state, so the user has visibility for the duration
# of a (potentially multi-minute) team run. Cerebro must call this BEFORE
# invoking the team via the Agent tool.
#
# Usage: bash announce-team-run.sh <team_id> <team_name> <strategy> <members_json>
#
# members_json is a JSON array of {member_id, member_name, role}, e.g.
#   '[{"member_id":"abc","member_name":"Running Coach","role":"coach"}]'

RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"

if [ ! -f "$RUNTIME_JSON" ]; then
  echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2
  exit 1
fi

PORT=$(jq -r .chat_actions_port "$RUNTIME_JSON" 2>/dev/null)
TOKEN=$(jq -r .chat_actions_token "$RUNTIME_JSON" 2>/dev/null)
if [ -z "$PORT" ] || [ "$PORT" = "null" ] || [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: chat-actions server not running" >&2
  exit 1
fi

TEAM_ID="\${1:-}"
TEAM_NAME="\${2:-}"
STRATEGY="\${3:-}"
MEMBERS_JSON="\${4:-}"
if [ -z "$TEAM_ID" ] || [ -z "$TEAM_NAME" ] || [ -z "$STRATEGY" ] || [ -z "$MEMBERS_JSON" ]; then
  echo "Usage: announce-team-run.sh <team_id> <team_name> <strategy> <members_json>" >&2
  exit 1
fi

# Validate that members is parseable JSON.
if ! echo "$MEMBERS_JSON" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "ERROR: <members_json> must be a JSON array" >&2
  exit 1
fi

BODY=$(jq -n \\
  --arg team_id "$TEAM_ID" \\
  --arg team_name "$TEAM_NAME" \\
  --arg strategy "$STRATEGY" \\
  --argjson members "$MEMBERS_JSON" \\
  '{team_id: $team_id, team_name: $team_name, strategy: $strategy, members: $members}')

RESPONSE=$(curl -s -w "\\n%{http_code}" \\
  -X POST "http://127.0.0.1:$PORT/chat-actions/announce-team-run" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d "$BODY") || {
  echo "ERROR: Cannot reach chat-actions server on port $PORT" >&2
  exit 1
}

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "SUCCESS: Announced team run for $TEAM_NAME"
  exit 0
fi
ERROR=$(echo "$BODY_RESPONSE" | jq -r '.error // ""')
echo "ERROR: \${ERROR:-Could not announce team run} (HTTP $HTTP_CODE)" >&2
exit 1
`,
    },
    {
      name: 'team-member-update.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Flips the status of a single team member in the live TeamRunCard. The
# team coordinator subprocess calls this at each member's start and end
# so the user can see which expert is currently working.
#
# Usage: bash team-member-update.sh <team_id> <member_id> <status> [error_message]
#
# status: running | completed | error
# error_message: optional one-line message when status=error

RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"

if [ ! -f "$RUNTIME_JSON" ]; then
  echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2
  exit 1
fi

PORT=$(jq -r .chat_actions_port "$RUNTIME_JSON" 2>/dev/null)
TOKEN=$(jq -r .chat_actions_token "$RUNTIME_JSON" 2>/dev/null)
if [ -z "$PORT" ] || [ "$PORT" = "null" ] || [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: chat-actions server not running" >&2
  exit 1
fi

TEAM_ID="\${1:-}"
MEMBER_ID="\${2:-}"
STATUS="\${3:-}"
ERROR_MESSAGE="\${4:-}"
if [ -z "$TEAM_ID" ] || [ -z "$MEMBER_ID" ] || [ -z "$STATUS" ]; then
  echo "Usage: team-member-update.sh <team_id> <member_id> <status> [error_message]" >&2
  exit 1
fi

case "$STATUS" in
  running|completed|error) ;;
  *)
    echo "ERROR: status must be running, completed, or error (got: $STATUS)" >&2
    exit 1
    ;;
esac

BODY=$(jq -n \\
  --arg team_id "$TEAM_ID" \\
  --arg member_id "$MEMBER_ID" \\
  --arg status "$STATUS" \\
  --arg error_message "$ERROR_MESSAGE" \\
  '{team_id: $team_id, member_id: $member_id, status: $status} + (if $error_message == "" then {} else {error_message: $error_message} end)')

RESPONSE=$(curl -s -w "\\n%{http_code}" \\
  -X POST "http://127.0.0.1:$PORT/chat-actions/team-member-update" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d "$BODY") || {
  echo "ERROR: Cannot reach chat-actions server on port $PORT" >&2
  exit 1
}

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')

if [ "$HTTP_CODE" = "200" ]; then
  exit 0
fi
ERROR=$(echo "$BODY_RESPONSE" | jq -r '.error // ""')
echo "ERROR: \${ERROR:-Could not update team member status} (HTTP $HTTP_CODE)" >&2
exit 1
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
| "Open a GitHub issue on owner/repo titled X" / "Abre un issue de GitHub en owner/repo titulado X" | \`github_create_issue\` |
| "Comment on issue #N in owner/repo: …" / "Comenta en el issue #N de owner/repo: …" | \`github_comment_issue\` |
| "Comment on PR #N in owner/repo: …" / "Comenta en el PR #N de owner/repo: …" | \`github_comment_pr\` |
| "Review PR #N in owner/repo and approve/request changes saying X" / "Revisa el PR #N en owner/repo y aprueba/pide cambios diciendo X" | \`github_review_pr\` |
| "Open a PR on owner/repo from feat/X to main titled Y" / "Abre un PR en owner/repo desde feat/X hacia main titulado Y" | \`github_open_pr\` |
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
    {
      name: 'propose-routine',
      description: 'Draft a Cerebro Routine from a natural-language request, confirm it with the user, dry-run it end-to-end (with side-effects stubbed), then save it on success.',
      body: `# Propose routine

Use this skill whenever the user asks for **recurring or triggered work** — anything they want Cerebro to run more than once on a schedule, on an inbound message, or by clicking Run. Phrases that should match (English **or** Spanish):

- "every Monday morning…", "daily at 8…", "cada lunes…", "todos los días…"
- "when a Telegram message arrives from…", "cuando llegue un WhatsApp…"
- "any time someone emails X, do Y", "set up a workflow that…"
- "make a routine that…", "crea una rutina que…"

For one-off work, use \`run-chat-action\` instead. For tracked tasks, use \`create-task\`.

## Workflow (always in this order)

### 1. Gather what you need

Find these in the conversation. If anything is missing, **ask one short clarifying question at a time** — don't dump a checklist.

- **name** — short title (3–8 words).
- **description** — one sentence about what the routine does.
- **trigger_type** — one of: \`manual\`, \`cron\`, \`webhook\`, \`telegram_message\`, \`whatsapp_message\`, \`github_issue_opened\`, \`github_pr_review_requested\`. The two GitHub triggers fire only for repos the user added to the watched-repo allowlist (Settings → Integrations → GitHub). Trigger payload (available as \`{{__trigger__.<field>}}\`): \`repo_full_name\`, \`repo_owner\`, \`repo_name\`, \`title\`, \`body\`, \`author_login\`, \`html_url\`, plus \`issue_number\` (issues) or \`pr_number\` (PRs).
- **cron_expression** — required when \`trigger_type=cron\`. Use 5-field cron (minute hour day-of-month month day-of-week, e.g. \`0 9 * * 1\` for "every Monday at 9am").
- **plain_english_steps** — array of human-readable step descriptions in order.
- **DAG steps** — programmatic version of the steps. Each step is:
  \`\`\`json
  {
    "id": "stable-id-1",
    "name": "Fetch order from HubSpot",
    "actionType": "<action_type>",
    "params": { /* per-action inputs */ },
    "dependsOn": [],
    "inputMappings": [],
    "requiresApproval": false,
    "onError": "fail"
  }
  \`\`\`

To see the full list of action types, action params, and which integrations are connected, run \`list-chat-actions\` first. Common action types include \`ask_ai\`, \`run_expert\`, \`classify\`, \`extract\`, \`summarize\`, \`search_memory\`, \`search_web\`, \`http_request\`, \`hubspot_create_ticket\`, \`hubspot_upsert_contact\`, \`send_telegram_message\`, \`send_whatsapp_message\`, \`send_notification\`, \`github_create_issue\`, \`github_comment_issue\`, \`github_comment_pr\`, \`github_review_pr\`, \`github_open_pr\`, \`github_fetch_issue\`, \`github_fetch_pr\`, \`github_clone_worktree\`, \`github_commit_and_push\`, \`condition\`, \`loop\`, \`delay\`. **Approval gates** (\`requiresApproval: true\` on a step, or a dedicated \`approval_gate\` step) are how a routine pauses for the user — recommend them for any external-facing send (Telegram, HubSpot, WhatsApp, email) and for any GitHub mutation (\`github_create_issue\`, \`github_comment_*\`, \`github_review_pr\`, \`github_open_pr\`, \`github_commit_and_push\`).

For the auto-fix-issue → PR pattern, the canonical DAG is: trigger \`github_issue_opened\` → \`github_fetch_issue\` (\`include_comments: true\`) → \`run_expert\` (analyze + plan) → \`github_clone_worktree\` → \`run_expert\` (write code in the worktree path) → \`github_commit_and_push\` (approval-gated) → \`github_open_pr\` (approval-gated). The expert step that writes code should pass \`workspacePath\` set to the worktree path so the file edits land in the cloned repo.

### 2. Wire steps together

Use \`inputMappings\` to feed an upstream step's output into a downstream step. Mapping shape:
\`\`\`json
{ "sourceStepId": "step-1", "sourceField": "result", "targetField": "input_field" }
\`\`\`
Use Mustache templates inside string params to read wired inputs: \`{{input_field}}\`.

For triggered routines, the inbound payload is exposed as a synthetic step \`__trigger__\`. Example for a Telegram trigger:
\`\`\`json
{ "sourceStepId": "__trigger__", "sourceField": "chat_id", "targetField": "trigger.chat_id" }
\`\`\`

### 3. Propose the routine to the user — do NOT save anything yet

Restate the routine in plain English with this structure:

\`\`\`
Here's the routine I'd build:

**Name:** <name>
**Trigger:** <human description, e.g. "Every Monday at 9 AM" or "When a Telegram message arrives from chat 123456">
**Steps:**
  1. <step 1 description>
  2. <step 2 description>
  …

Want me to test and save this, or change something first?
\`\`\`

Then **wait for the user's reply**. Only continue once they say "yes / save / go ahead / sounds good / ship it" (or the Spanish equivalent). If they ask for changes, regenerate the proposal and ask again.

### 4. Tell the user testing will take a moment

Before you run the dry-run, say something like:

> Testing the routine end-to-end now — this can take a couple of minutes while I exercise every step with safe stand-ins for the real integrations.

### 5. Run the dry-run

Build the dag JSON, write it to a tmp file, then test it:

\`\`\`bash
jq -n --argjson dag 'DAG_JSON' '{dag: $dag}' \\
  > "$CLAUDE_PROJECT_DIR/.claude/tmp/dry-run-routine.json" && \\
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/dry-run-routine.sh" \\
  "$CLAUDE_PROJECT_DIR/.claude/tmp/dry-run-routine.json"
\`\`\`

The script blocks until the engine finishes and prints a JSON object with \`{ok, runId, error?, failedStepId?, steps: [...] }\`. Inspect:

- **\`ok: true\`** → every step completed (with side-effects stubbed). Move on to step 6.
- **\`ok: false\`** → tell the user *which* step failed (look up the failed step in \`.steps\` by \`failedStepId\`) and what the error said. Offer to amend and re-run, or stop. **Never persist a routine that fails its dry-run.**

### 6. Save the routine

Build the final body. \`dag_json\` MUST be a JSON-encoded **string**, not an object. Then:

\`\`\`bash
jq -n \\
  --arg name "ROUTINE_NAME" \\
  --arg description "ROUTINE_DESCRIPTION" \\
  --arg trigger_type "TRIGGER_TYPE" \\
  --arg cron_expression "CRON_OR_EMPTY" \\
  --arg dag_json "DAG_AS_JSON_STRING" \\
  --argjson plain_english_steps 'PLAIN_STEPS_ARRAY' \\
  --argjson required_connections 'CONNECTIONS_ARRAY' \\
  --argjson approval_gates 'APPROVAL_STEP_IDS_ARRAY' \\
  '{name: $name, description: $description, trigger_type: $trigger_type, cron_expression: (if $cron_expression == "" then null else $cron_expression end), dag_json: $dag_json, plain_english_steps: $plain_english_steps, required_connections: $required_connections, approval_gates: $approval_gates, source: "user"}' \\
  > "$CLAUDE_PROJECT_DIR/.claude/tmp/save-routine.json" && \\
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/save-routine.sh" \\
  "$CLAUDE_PROJECT_DIR/.claude/tmp/save-routine.json"
\`\`\`

If the output starts with \`SUCCESS:\`, tell the user the routine was saved (mention the name) and that it appears in the Routines screen. If it starts with \`ERROR:\`, surface the error and stop.

## Hard rules

- **Always propose first, then test, then save.** Skipping the proposal step is a contract violation.
- **Never save a routine that failed dry-run.** Tell the user what broke and offer to fix it.
- **Always tell the user testing takes a couple of minutes** before kicking off the dry-run.
- **For external-facing actions** (Telegram, WhatsApp, HubSpot, email, run_command), **add an \`approval_gate\` step or set \`requiresApproval: true\`** on the action step so real runs pause for the user.
- Reply in the user's language (English or Spanish) throughout.
`,
    },
    {
      name: 'connect-integration',
      description:
        'Open the inline setup card so the user can connect an integration (Telegram, HubSpot, WhatsApp, GoHighLevel, …) without leaving the chat. Never ask for tokens in chat — the card collects them securely.',
      body: `# Connect an integration

Use this skill whenever the user asks Cerebro to **connect, set up, link, or wire up** an external service — anything that needs credentials before \`run-chat-action\` or a routine can use it. Phrases that should match (English **or** Spanish):

- "set up Telegram", "connect Telegram", "help me set up the Telegram bot"
- "configura HubSpot", "conecta WhatsApp", "vincula mi cuenta de HubSpot"
- "I want to use Telegram with Cerebro", "how do I connect HubSpot"
- "connect GoHighLevel", "set up GHL", "conecta GoHighLevel", "vincula mi CRM de GHL"

Currently supported \`integration_id\` values: \`telegram\`, \`hubspot\`, \`whatsapp\`, \`ghl\`, \`github\`. Others — including everything listed as "coming soon" in the Integrations screen — are not yet implemented; tell the user it's on the roadmap and stop.

## Workflow

1. **Confirm intent and pick the integration_id.** Match the user's wording to one of \`telegram\`, \`hubspot\`, \`whatsapp\`, \`ghl\`, \`github\`. "GoHighLevel" / "GHL" / "Lead Connector" all map to \`ghl\`. "GitHub" / "gh" / "git" (when context makes it clear they mean github.com) maps to \`github\`. If the user is ambiguous (e.g. "set up CRM"), ask one short clarifying question (HubSpot or GoHighLevel?).
2. **Open the setup card.** Run:

   \`\`\`bash
   bash "$CLAUDE_PROJECT_DIR/.claude/scripts/propose-integration.sh" INTEGRATION_ID "WHY_THIS_INTEGRATION"
   \`\`\`

   Replace \`INTEGRATION_ID\` with one of \`telegram\` / \`hubspot\` / \`whatsapp\` / \`ghl\` / \`github\`. The reason argument is optional and shown as the card subtitle ("So you can send WhatsApp from routines", "So Cerebro can drive your GitHub repos").

3. **Tell the user the card is ready.** One short line in their language: "I'll help you connect Telegram. Open the setup card below." Don't dump instructions — the card already shows the BotFather/Private App walkthrough.

4. **Answer follow-up questions conversationally.** While the card is open, the user may ask things like "what's BotFather?", "where do I find scopes in HubSpot?", "do I need WhatsApp Business?". Use this prose as your source of truth so you don't make things up:

   ### Telegram (BotFather)
   - Open Telegram and start a chat with **@BotFather** (the @ matters — confirm exactly that handle).
   - Send \`/newbot\` and follow the prompts to name your bot and pick a unique username (must end in \`bot\`).
   - BotFather replies with a token like \`123456789:AABBccDD…\`. Copy it.
   - Paste the token in the card's step 2. Cerebro verifies it against Telegram's getMe API and stores it encrypted in the OS keychain.

   ### HubSpot (Private App access token)
   - In HubSpot, open **Settings → Integrations → Private Apps** (also reachable via the Legacy Apps shortcut).
   - Click **Create a private app**, name it (e.g. "Cerebro"), and click **Scopes**.
   - Enable read+write on **tickets**, **contacts**, and **pipelines** (CRM scopes).
   - Click **Create app**, then **Show token** and copy the \`pat-na1-…\` value.
   - Paste the token in the card's step 2. Cerebro verifies it via the HubSpot account-info API.

   ### WhatsApp (QR pairing)
   - Open WhatsApp on the user's phone (regular or Business).
   - Settings → **Linked devices** → **Link a device**.
   - The card shows a QR code; scan it with the phone.
   - Once paired, the card flips to "Connected".

   ### GoHighLevel (Private Integration API key + Location ID)
   - In GoHighLevel, open **Settings → Integrations → Private Integrations** in the sub-account they want to sync.
   - Click **Create New Integration**, name it (e.g. "Cerebro"), and select the **contacts** + **notes** scopes (read + write).
   - After creation GHL shows a Private Integration API key starting with \`pit-…\`. Copy it.
   - The **Location ID** is the sub-account id — it appears in the GHL URL (\`/v2/location/<location-id>/…\`) and in **Settings → Business Profile**.
   - Paste both values in the card's step 2. Cerebro verifies them by hitting GHL's contacts search API for that location.

   ### GitHub (Personal Access Token)
   - In GitHub, open **Settings → Developer settings → Personal access tokens**. Either **Tokens (classic)** or **Fine-grained tokens** works.
   - For a **classic** token: enable the \`repo\` scope (and \`read:user\`, which is automatic). For a **fine-grained** token: select the repos Cerebro should touch and grant **Issues: read+write**, **Pull requests: read+write**, **Contents: read+write**.
   - Generate the token. GitHub only shows it once — copy it before leaving the page.
   - Paste it in the card's step 2. Cerebro verifies it by calling \`/user\`.
   - After connecting, the user picks **watched repositories** (Settings → Connected Apps → GitHub). Routine triggers (\`github_issue_opened\`, \`github_pr_review_requested\`) only fire for repos in that list. Outbound chat actions can target any repo the token reaches.

5. **Don't ask for credentials in chat.** The card's input fields collect tokens directly through the secure IPC bridge so secrets never reach the LLM context. If the user pastes a token in chat by mistake, ignore it and remind them to enter it in the card.

## Interpreting the script output

- \`SUCCESS:\` — card opened. Tell the user.
- \`ERROR:\` — surface the message verbatim. Common causes: unknown \`integration_id\`, chat-actions server not running, main window not ready.

## What this skill does NOT do

- Walk the user through setup in plain text. The card owns the walkthrough.
- Collect, store, or even read credentials. The card does that.
- Connect integrations not in the registry yet. If the user asks for Slack / Gmail / Notion / Calendar, say it's on the roadmap and stop.
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

interface ContextFileData {
  id: string;
  file_name: string;
  file_ext: string;
  kind: string;
  parsed_text_path: string | null;
  file_storage_path: string;
  truncated: boolean;
}

async function fetchExpertContextFiles(
  backendPort: number,
  expertId: string,
): Promise<ContextFileData[]> {
  const result = await fetchJson<ContextFileData[]>(
    backendPort,
    `/experts/${expertId}/context-files`,
  );
  return result ?? [];
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

  // Fetch skills + context files for each regular expert (teams don't carry either).
  const [regularSkillSets, regularContextSets] = await Promise.all([
    Promise.all(
      regulars.map((expert) => fetchExpertSkills(options.backendPort, expert.id)),
    ),
    Promise.all(
      regulars.map((expert) =>
        fetchExpertContextFiles(options.backendPort, expert.id),
      ),
    ),
  ]);

  const agentNameById: Record<string, string> = {};
  const memberNamesById: Record<string, string> = {};

  for (let i = 0; i < regulars.length; i++) {
    const expert = regulars[i];
    const agentName = expertAgentName(expert.id, expert.name);
    seen.add(agentName);
    writeExpertAgent(
      paths,
      expert,
      agentName,
      regularSkillSets[i],
      regularContextSets[i],
    );
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
    const [skills, contextFiles] = await Promise.all([
      fetchExpertSkills(options.backendPort, expert.id),
      fetchExpertContextFiles(options.backendPort, expert.id),
    ]);
    writeExpertAgent(paths, expert, agentName, skills, contextFiles);
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
  contextFiles: ContextFileData[] = [],
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
    body: buildExpertBody(expert, memoryDir, skills, contextFiles),
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
