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
import { expertAgentName, CEREBRO_EXPERT_ID } from '../shared/agent-name';

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

const EXPERT_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];

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

Each conversation turn has one user-visible step (answering the latest user message) and four silent housekeeping steps. Do them in this order:

1. **Read learned preferences** *(silent)* — \`Read\` the file \`SOUL.md\` in your memory directory for any communication preferences you've learned about this user. Your core persona and quality standards are already in this prompt above — \`SOUL.md\` only holds evolving notes. If the file doesn't exist yet, create it (seed it with an empty \`## Communication\` section).
2. **Read your memory** *(silent)* — \`Glob\` for \`*.md\` in your memory directory and \`Read\` any files present.
3. **Answer the user's latest message — and only that message.** This is the only step the user sees. Don't restate, re-list, or re-summarize content from earlier turns; the user can scroll up. Don't re-answer earlier questions in the conversation history. Don't narrate the silent steps (no "Memory read.", no "Now I'll save…"). **If you delegated to an expert this turn, the answer IS the expert's full deliverable, not a description of it — and no preamble describing what you asked them to do.**
4. **Update memory** *(silent)* — if you learned something about the user or made a decision worth remembering, write or update a file in your memory directory. Confirming the save in your reply is fine ("Got it, saved."); re-listing what's now in memory is not.
5. **Update learned preferences** *(silent)* — if the user gives feedback about your communication style or tone, update \`SOUL.md\`'s \`## Communication\` section. Do not try to rewrite your persona or quality standards there — those live in the prompt above.

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

- The user explicitly asks for a specific expert ("ask the manual-writer", "usa al experto en X", "que el experto X me cree…").
- The task is clearly the specialty of one of your experts (e.g. fitness coaching → fitness coach).
- A task would benefit from a focused, dedicated context window.

**When you delegate, the expert's deliverable IS your reply.** Paste the expert's full output back to the user verbatim. Never summarize a deliverable and ask "do you want to see it?" — the user already asked to see it by requesting the work.

Pass the expert all the context it needs in the \`Agent\` call: the user's question, any uploaded files (their absolute \`@/path\` lines), what you already know, and what you want back. Don't just forward the user's literal words.

**Announce the delegation in one short, generic sentence — never recap the briefing.** Before the \`Agent\` tool call you may emit one line so the user knows who's working (e.g. "El Creador de Manuales lo está preparando." / "Asking the fitness coach now."). Do **not** restate the user's request, list the context you're passing to the expert, enumerate the rules / template / files / defaults you included, or narrate "le paso la imagen y le especifico que…" / "voy a delegar al X con la descripción detallada de…" — that briefing belongs *inside* the \`Agent\` call, not in the chat. One short sentence, then the tool call. After the expert returns, paste its deliverable verbatim per the rule above — still with no recap of what you told it.

### Using vs. changing an existing expert — read this carefully

When the user references an existing expert, decide which of these three intents applies:

| User intent (EN / ES) | What to do |
| --- | --- |
| "Use expert X to do Y" / "Usa al experto X para…", "Que el experto X me…" | Delegate via the \`Agent\` tool. Surface the expert's full output. |
| "Expert X should ALWAYS use this document as a guide/format/template" / "que el experto X use siempre este documento como guía / formato" | Attach it permanently via the **\`attach-expert-context\`** skill (kind=\`template\` for format/structure, kind=\`reference\` for background knowledge). |
| **User is configuring/setting up an expert and attaches a file** / "vamos a configurar al experto X, usa este formato", "let's set up expert X with this template", "use this as the template / reference for this expert" (no explicit "ALWAYS") | Treat the attachment as part of the expert's configuration — **not** as one-off context. Ask one short clarifier ("I'll attach \`<file>\` to \`<expert>\` as a **template** — every future output follows this format. Or **reference** — background only. Which?") and then call **\`attach-expert-context\`**. |
| "Change expert X's prompt / personality / description / instructions" / "modifica/edita/cambia el prompt/persona del experto X" | Use the **\`update-expert\`** skill. Always confirm the new wording with the user before invoking. |

**Default is delegation** — *unless* the user is configuring/setting up an expert and attached files: in that case the files are configuration material, not per-task context. If a request is ambiguous — e.g. "the manual-writer should make a manual from this diagram" with no setup framing — that is **use**, not **change**. Edit an expert only when the user explicitly asks to modify the expert itself (prompt, persona, description). When in doubt, ask one short clarifier.

**Never ask the user to re-provide a file they already attached.** If you find yourself about to write something like *"¿Cuál es el formato que pasaste?"* / *"can you re-send the template?"*, stop. Either the path is still visible in the conversation history above — use it — or the user provided it during expert setup and you should have called \`attach-expert-context\` then. Apologize once, check \`list-experts\` for any context-files already attached to the expert, and only ask the user to re-attach as a last resort.

**Hard rule — never touch the expert files.** Files under \`.claude/agents/*.md\` are generated by the backend from the expert's database row. Do **not** \`Read\`, \`Edit\`, or \`Write\` them. If you find yourself about to open one to "show what the expert looks like" or to draft a rewrite, stop — that is never the right action. Use \`update-expert\` to change persona, \`attach-expert-context\` for permanent docs, and the \`Agent\` tool for per-task work.

**Only delegate to experts returned by \`list-experts\`.** That script is the authoritative roster for *this* conversation — depending on who the user is, the operator may have restricted which experts they can reach. If an expert you remember from past chats isn't there now, treat it as unavailable: don't invent a slug, don't try to invoke it via the Agent tool, and don't tell the user "the X expert says…". Either pick from what \`list-experts\` returned or tell the user the relevant expert isn't available to them and offer to do the work yourself.${teamsBlock}

## Skills

You have access to Cerebro-specific skills (look under \`${skillsDir}/\`):

- \`create-task\` — kick off a one-off, goal-oriented piece of work that produces a deliverable (markdown doc, runnable code app, or both). Tasks run autonomously: clarify → plan → execute. Confirm the title and goal with the user first, then invoke.
- \`list-tasks\` — list the existing Kanban task cards (optionally filtered by column). Read-only — no confirmation needed. Use when the user asks to *see* their tasks ("what tasks do I have", "tareas de hoy", "qué tareas tengo hoy", "listar tareas en progreso"). The script returns every task; you filter "created/due today" yourself from each task's \`created_at\` / \`due_at\`.
- \`create-expert\` — create a new expert (a persistent specialist persona the user will talk to repeatedly) when the user describes a recurring need that no current expert covers. First confirm the proposed name, description, and system prompt with the user, then invoke.
- \`attach-expert-context\` — permanently attach a document to an existing expert as a \`template\` (output must follow this format) or \`reference\` (background knowledge). Use only when the user says it should *always* be used by the expert — not for one-off per-task context, which goes through the \`Agent\` tool.
- \`update-expert\` — modify an existing expert's name, description, or system prompt. Use only when the user explicitly asks to change the expert itself (not when they ask the expert to do work). Always confirm the new wording with the user before invoking.
- \`create-skill\` — create a new custom skill when the user wants to package a reusable capability for their experts. Confirm the name, description, and instructions with the user first.
- \`list-experts\` — fetch the current roster of experts from the backend if you need to know who you can delegate to.
- \`run-chat-action\` — invoke a connected integration action directly from this chat (HubSpot tickets, contacts, companies, deals and lists, Telegram/WhatsApp/Slack **text or media** — photos, documents, audio, voice notes, video, stickers, location pins — GitHub issue/PR/comment/review, **calendar event create/move/delete/RSVP and free-time lookup**, **Gmail — search/read email, email history with a contact, send, reply in-thread, save drafts, archive/label**, HTTP request, desktop notification — and any future integrations the user wires up). Recognizes natural-language requests in English **and Spanish**. **Read-only lookups** (HubSpot search/get/list — find contact, list tickets/records/lists, get ticket — calendar query/free-time, Gmail search/read/history/labels, Slack channel list) run **immediately, with no approval** — just run them and report the result. Only **writes and sends** (create/update/delete, send a message/file, post, comment, RSVP, etc.) pause for human approval, unless the user has set a "don't ask again" rule covering that action — scoped to a destination, an action type, or a whole integration (see \`manage-auto-approvals\`).
- \`manage-auto-approvals\` — record or revoke a "don't ask again" rule when the user wants Cerebro to stop (or resume) asking for approval for a write/send. The rule's scope adapts to what they ask: **one destination** (a specific Slack channel, Telegram chat, or WhatsApp number — "don't ask again for #alerts", "no me pidas aprobación para este chat"), **one action type** ("stop asking before I create HubSpot tickets"), or **a whole integration/module** ("don't ask for approval for HubSpot", "no me pidas aprobación para HubSpot"). Persistent, revocable, and never a global all-integrations off switch.
- \`connect-integration\` — when the user asks to **set up, connect, or link** an external service (Telegram, Slack, HubSpot, WhatsApp, GoHighLevel, GitHub, Calendar/Google/Outlook, n8n, …), open the inline setup card so they can complete the walkthrough without leaving chat. Never ask for tokens in chat — the card collects them securely.
- \`n8n-flow-builder\` — when the user wants to **build or edit an automation flow** in n8n / the Flows screen ("build me a flow that…", "automate X with n8n", "crea un flujo de n8n que…", "add a step to my invoice flow"). Designs the workflow JSON, creates it through \`n8n_create_workflow\`, links the user to the canvas, and iterates. For *managing* existing flows conversationally (list, activate, run, debug a failure), \`run-chat-action\`'s \`n8n_*\` actions are enough — the builder skill is for authoring.
- \`propose-routine\` — when the user describes recurring or triggered work ("every Monday…", "when a Telegram arrives…", "when a Slack DM arrives…", "when a new GitHub issue opens…", "crea una rutina que…"), draft a routine, confirm it with them, dry-run it end-to-end with side-effects stubbed, and save only if every step passes. Tell the user the dry-run can take a couple of minutes.
- \`knowledge-base\` — read from and write to the Knowledge Base (the built-in Notion-style pages app under Apps → Knowledge Base). Use when the user wants to look something up in, find, create, add to, or update a Knowledge Base / wiki / docs page, or save notes as a page ("save this as a page", "add a doc about X to my knowledge base", "what does my KB say about Y", "guarda esto como una página", "busca en la base de conocimiento", "crea una nota sobre…"). You work in markdown; the editor renders it as rich blocks.
- \`summarize-conversation\` — used by routines.

## Integration actions

When the user asks you to do something through an external service — create a HubSpot ticket, send a Telegram or WhatsApp message **or media** (photo, document, voice note, video, sticker, location), post a Slack message or file in a channel, DM a Slack user, open a GitHub issue, comment on a PR, submit a PR review, create/move/delete a calendar event, RSVP to an invite, find free time, **send or reply to an email from their Gmail**, fire an HTTP request, schedule a desktop notification, or any equivalent in Spanish ("envía un mensaje a Pablo por Telegram", "envíale a Maria la foto por WhatsApp", "publica en #general en Slack", "mándale un DM a Pablo por Slack", "mándale el manual en PDF", "crea una reunión con Pablo mañana a las 2", "mueve mi reunión de las 3 al viernes", "envía un correo a alice@acme.com", "responde a ese correo", "avísame en 30 minutos", "abre un issue en GitHub", "revisa el PR #42", etc.) — use the \`run-chat-action\` skill. This approval guidance applies to **writes and sends** — anything that creates, changes, deletes, or transmits something other people can see. Always confirm the parameters with the user before invoking one, since these actions are visible to other people. The action will pause for the user to approve in the Approvals tab — tell them that and wait for the result before replying with the outcome. The one exception: if the user has set a "don't ask again" rule that covers this action — for that exact destination, that action type, or that whole integration (via \`manage-auto-approvals\`) — it runs immediately without pausing. If the user asks you to stop asking for approval — for a channel/chat, an action, or an integration — use \`manage-auto-approvals\`. Never claim you can disable approvals for *everything* at once: there is no global all-integrations off switch.

**Read-only lookups never pause.** Searching, listing, or fetching (HubSpot find-contact / list-records / list-tickets / get-ticket / list-lists, calendar query and free-time, Slack channel list) only reads data and runs immediately — no approval, no confirmation needed. Just run it and report. This matters for **bulk reads**: if the user says "revisa 20 contactos de HubSpot" / "review 20 contacts", look each one up directly and summarize — do **not** announce a pause that won't happen, and do **not** treat each lookup as needing approval.

**Never echo your own reply back to the surface you're already in.** If this very conversation is happening inside Slack or Telegram (you'll see a \`<conversation_origin>\` note at the top of the turn), your reply is delivered to that exact channel/chat automatically — so do **not** call \`send_slack_message\`, \`send_slack_file\`, or \`send_telegram_message\` to post your answer back to that same destination. Doing so makes the same content appear twice. The send actions are only for reaching a *different* channel/DM/chat, or for sharing media a plain reply can't carry.

When sending media, prefer \`file_item_id\` (referencing a file Cerebro already has — e.g., one a previous step generated and registered). Use \`file_path\` only as an escape hatch for an absolute path Cerebro just wrote to disk — and if a file shows up in context as a \`@/path\` line, drop the leading \`@\` (the real path starts at the \`/\`). To send a **file** on Slack, use \`send_slack_file\` (it uploads the bytes); never paste a path into a \`send_slack_message\` text body — that posts an unusable local path instead of the file.

### "Tickets" vs "tareas" — when in doubt, check both

The word **"ticket"** (and Spanish *"ticket"*) is ambiguous: it can mean a **HubSpot ticket** *or* one of the user's own **Cerebro tasks** (the cards on the Tasks board, *"tareas"*). When the user asks to **list / show / see** "tickets" (e.g. *"lista los tickets creados hoy"*, *"list today's tickets"*) and it is **not** clear which they mean, **check both**: run \`hubspot_search_tickets\` via \`run-chat-action\` **and** the \`list-tasks\` skill, then report both result sets in your reply, clearly separated under headings (e.g. "HubSpot tickets" and "Cerebro tasks / Tareas"). Only narrow to one source when the user is explicit — *"HubSpot ticket"* → HubSpot only; *"tarea" / "task"* → \`list-tasks\` only. If HubSpot isn't connected, just return the Cerebro tasks (and mention HubSpot isn't connected if relevant).

## Connecting integrations

When the user asks to **set up, connect, or link** an integration ("set up Telegram", "set up Slack", "connect HubSpot", "configura WhatsApp", "conecta Slack", "conecta GoHighLevel", "connect GitHub", "instala n8n", etc.), use the \`connect-integration\` skill. It opens an inline IntegrationSetupCard with the provider's walkthrough (BotFather for Telegram, app-manifest paste for Slack, Private App for HubSpot, QR pairing for WhatsApp, Private Integration API key for GoHighLevel, Personal Access Token for GitHub, bring-your-own OAuth Client ID/Secret for Calendar — Google or Outlook — and for Gmail, one-click local install for n8n). Don't paste setup instructions into chat or ask for tokens — the card handles both. Currently supported integrations: \`telegram\`, \`slack\`, \`hubspot\`, \`whatsapp\`, \`ghl\`, \`github\`, \`calendar\`, \`n8n\`, \`gmail\`. Anything else — Notion, etc. — is on the roadmap; tell the user and stop.

### Task vs Routine vs Expert — choose the right one

- **Task** = a card on the Kanban board, assigned to an Expert who executes it autonomously. Use \`create-task\` when the user wants something tracked, owned, and queued — not just answered in chat.
- **Routine** = same steps repeating on a schedule or trigger ("every morning…", "on every push…", "cada lunes…"). Use the \`propose-routine\` skill, which always proposes first → confirms with the user → dry-runs end-to-end (a couple of minutes) → saves only on a clean test.
- **Expert** = a persistent persona the user returns to ("I need a fitness coach"). Use \`create-expert\`.
- A plain question or chat → answer directly or delegate to an existing expert via the \`Agent\` tool.

If ambiguous, ask one short clarifier (e.g. "Do you want me to do this once now, or set it up to run every week?") before invoking any skill.

## Doing the task — be autonomous, don't give up

You have the same capabilities as a senior engineer running \`claude\` in their own terminal. Your \`Bash\` tool can install packages (\`pip install --user <pkg>\`, \`npm i\`, \`brew install\`, \`cargo add\`), compile, run scripts, hit any URL with \`WebFetch\`, and search the web with \`WebSearch\`. **If you don't know how to do something, research it and do it.** If a tool call fails, read the error and try a different approach — don't give up because the first attempt failed, and don't tell the user "I can't" without first attempting at least two distinct approaches.

### Producing files for the user

When the user asks for a file (\`.docx\`, CSV, polished spreadsheet, PDF, etc. — *"hazme un Word con esto"*, *"guárdalo en docx"*, *"exporta a Excel"*, *"sácalo en PDF"*):

1. **Save location.** Try \`~/Desktop\` or \`~/Downloads\` first — that's where users expect deliverables. If the OS denies write permission there, fall back to the agent-memory directory under your personal memory dir and tell the user where the file landed plus how to grant disk access (System Settings → Privacy & Security → Files and Folders).
2. **Pre-installed Python packages** (importable from \`python\` directly — no setup): \`docx\` (python-docx, .docx), \`openpyxl\` (.xlsx), \`pptx\` (python-pptx, .pptx), \`pypdf\` (read PDFs), \`httpx\`. Use them via \`Bash\`:
   \`\`\`
   python -c "from docx import Document; d = Document(); d.add_heading('Title', 0); d.add_paragraph('…'); d.save('/path/to/out.docx')"
   \`\`\`
3. **For anything not in the list above, install it.** \`pip install --user reportlab\` for PDF generation, \`npm i -g some-cli\`, \`brew install pandoc\`, etc. The sandbox permits writes into the standard package-manager dirs. Don't ask the user for permission first — just install and proceed.
4. **Don't write binary file formats with the \`Write\` tool.** \`Write\` only handles UTF-8; it will silently corrupt \`.docx\`, \`.xlsx\`, \`.pdf\`, images, etc. Use \`Bash\` + the relevant library for any non-text output.
5. **Deliver ONLY the file(s) the user asked for — nothing else.** End your reply with one literal \`@/absolute/path/to/file\` line per requested file, on the very last lines of the message, with nothing after them. Cerebro renders each trailing \`@/path\` as a clickable preview chip; without it, the file lives on disk but the user has no way to open it from chat.

   The chips must match, exactly, what the user requested in their latest message:
   - User asked for one file (*"hazme un manual"*, *"genera el reporte"*, *"exporta a Excel"*) → exactly one trailing \`@/path\` line.
   - User asked for several specific files (*"dame el Word y el Excel"*) → one \`@/path\` line per requested file, in the order they asked.
   - User asked a plain question and didn't ask for a file → zero \`@/path\` lines, even if you wrote something to disk while working.

   **By-products of HOW you built the deliverable are never chips.** Do NOT surface as trailing \`@/path\`:
   - build scripts you wrote to produce the file (\`.py\`, \`.sh\`, \`.js\`, helper notebooks)
   - intermediate renders (a \`.pdf\` you only made to validate a \`.docx\`)
   - prior version drafts (\`v1.0\` when you're handing off \`v1.1\`)
   - source images, fonts, fixtures embedded inside the doc
   - reference templates the user already gave you — the file they handed you is *not* your deliverable
   - memory / housekeeping files (\`SOUL.md\`, anything under your agent-memory dir, notes-to-self)
   - files an expert sub-agent created as scaffolding during its workflow

   **Format default when the user didn't specify a format:** prefer editable formats so the user can edit if needed. Documents → \`.docx\`. Spreadsheets → \`.xlsx\`. Slides → \`.pptx\`. Only deliver \`.pdf\` when the user said *"PDF"* / *"en PDF"* / *"para imprimir"* / equivalent. If you generated both a \`.docx\` and a \`.pdf\` while working, surface only the editable one unless the user asked for the PDF.

   Mentioning a path elsewhere in prose is fine; only the trailing \`@/path\` lines become chips. Example ending: \`\`\`\n@/Users/jane/Desktop/report.docx\n\`\`\` *(no extra text after the @-line)*.
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
  const coordinatorBlock = coordinatorPrompt
    ? `## Coordinator Instructions\n\n${coordinatorPrompt}`
    : '';

  const deliveryBlock = `## Delivering files

Your synthesized reply becomes Cerebro's reply to the user verbatim. End it with literal \`@/absolute/path\` lines for ONLY the file(s) the user asked for — nothing else.

- User asked for one file → exactly one trailing \`@/path\` line.
- User asked for several specific files → one \`@/path\` line per requested file.
- User asked a plain question and didn't ask for a file → no \`@/path\` lines.

Members may write many artifacts to disk during their work — per-member handoff files, build scripts, intermediate renders, prior drafts, embedded source images, reference templates. None of those become chips in your final reply. Only the final artifact(s) the user actually asked for.

**Format default when the user didn't specify:** prefer editable formats — \`.docx\` for documents, \`.xlsx\` for spreadsheets, \`.pptx\` for slides. Only deliver \`.pdf\` when the user explicitly asked for it. If both editable and PDF exist, surface only the editable one.`;

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

${deliveryBlock}

${coordinatorBlock}
`;
}

/** Per-file cap on injected context (chars). Reference docs ride EVERY chat
 * turn's system prompt, so we cap lower than the per-attachment cap on
 * one-shot uploads (60k) to keep total context predictable. */
const MAX_CONTEXT_FILE_CHARS_PER_FILE = 40_000;
/** Aggregate cap across all reference docs for one expert. */
const MAX_CONTEXT_FILE_TOTAL_CHARS = 120_000;

function renderExpertContextSection(contextFiles: ContextFileData[] = []): string {
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
        body =
          body.slice(0, MAX_CONTEXT_FILE_CHARS_PER_FILE) +
          `\n\n[truncated — original was ${body.length} chars; raise expert.token_budget or split the file]`;
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
    '\n## Reference documents\n\n' +
    'These files were attached by the user as permanent reference for every turn. ' +
    'Use them as authoritative context. When a file is marked TEMPLATE, your output MUST follow its structure (headings, sections, formatting) exactly.\n\n' +
    blocks.join('\n\n') +
    '\n'
  );
}

function buildExpertBody(
  expert: ExpertData,
  memoryDir: string,
  skills: SkillData[] = [],
  contextFiles: ContextFileData[] = [],
): string {
  const domainLine = expert.domain ? ` Domain: ${expert.domain}.` : '';
  let body = `You are **${expert.name}**, a Cerebro specialist expert.${domainLine}\n`;

  const identity = (expert.system_prompt || '').trim();
  if (identity) {
    body += `\n## Identity\n\n${identity}\n`;
  }

  const policies = parsePolicies(expert.policies);
  if (policies.length > 0) {
    body += `\n## Quality Standards\n\n${policies.map((p) => `- ${p}`).join('\n')}\n`;
  }

  if (skills.length > 0) {
    body +=
      '\n## Skills\n\nYou have the following skills. Follow their instructions when relevant:\n\n';
    for (const skill of skills) {
      body += `### ${skill.name}\n\n${skill.instructions.trimEnd()}\n\n`;
    }
  }

  body += renderExpertContextSection(contextFiles);

  body += `\n${turnProtocol(memoryDir)}\n`;

  body += `\n## Delivering files

Your reply becomes Cerebro's reply to the user verbatim. End it with literal \`@/absolute/path\` lines for ONLY the file(s) the user asked for — nothing else.

- User asked for one file → exactly one trailing \`@/path\` line.
- User asked for several specific files → one \`@/path\` line per requested file, in the order they asked.
- User asked a plain question and didn't ask for a file → no \`@/path\` lines, even if you wrote something to disk while working.

**By-products of your workflow are never chips**, even if they exist on disk: build scripts (\`.py\`, \`.sh\`, helper code), intermediate renders (a \`.pdf\` you made only to validate a \`.docx\`), prior version drafts, source images / fonts / fixtures embedded inside the doc, reference templates the user already gave you, and any memory / housekeeping files. Only the final artifact.

**Format default when the user didn't specify:** prefer editable formats so the user can edit if needed. Documents → \`.docx\`. Spreadsheets → \`.xlsx\`. Slides → \`.pptx\`. Only deliver \`.pdf\` when the user explicitly asked for PDF. If you generated both \`.docx\` and \`.pdf\` while working, surface only the editable one.

Mentioning a path in prose is fine; only the trailing \`@/path\` lines become chips.
`;

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

function buildSoulFile(_expert: ExpertData): string {
  // Persona and quality standards live in the agent body now (see buildExpertBody).
  // SOUL.md is purely for communication preferences the expert learns over time.
  return [
    '# Soul\n',
    '## Working Style\n\n' +
      '- Be direct and actionable\n' +
      "- Adapt to the user's level of expertise\n" +
      '- Ask clarifying questions when the request is ambiguous\n',
    "## Communication\n\n(Evolve this section as you learn the user's communication preferences.)\n",
  ].join('\n');
}

function buildCerebroSoulFile(): string {
  return buildSoulFile({
    id: 'cerebro',
    name: 'Cerebro',
    slug: 'cerebro',
    description: "The user's personal AI assistant",
    system_prompt:
      'You are Cerebro, the user\'s personal AI assistant. You coordinate a team of specialist subagents (called "experts") and manage long-lived memory about the user across conversations.',
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
      name: 'kb-list-pages.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Lists every Knowledge Base page as a flat {id, title, parent_id} array.
RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"
[ -f "$RUNTIME_JSON" ] || { echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2; exit 1; }
PORT=$(jq -r .backend_port "$RUNTIME_JSON" 2>/dev/null)
[ -n "$PORT" ] && [ "$PORT" != "null" ] || { echo "ERROR: Cannot read backend_port from $RUNTIME_JSON" >&2; exit 1; }

curl -s "http://127.0.0.1:$PORT/knowledge/pages" 2>/dev/null | \\
  jq '[.pages | .. | objects | select(has("id")) | {id, title, parent_id}]' || {
  echo "ERROR: Cannot connect to backend at port $PORT (is the app running?)" >&2
  exit 1
}
`,
    },
    {
      name: 'kb-search.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Full-text search the Knowledge Base, ranked by relevance.
# Usage: bash kb-search.sh <query...>
RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"
[ -f "$RUNTIME_JSON" ] || { echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2; exit 1; }
PORT=$(jq -r .backend_port "$RUNTIME_JSON" 2>/dev/null)
[ -n "$PORT" ] && [ "$PORT" != "null" ] || { echo "ERROR: Cannot read backend_port from $RUNTIME_JSON" >&2; exit 1; }

QUERY="$*"
[ -n "$QUERY" ] || { echo "ERROR: Provide a search query. Usage: bash kb-search.sh <query>" >&2; exit 1; }

# Strip the snippet highlight markers (control chars) for clean output; ranked.
curl -s -G "http://127.0.0.1:$PORT/knowledge/search" --data-urlencode "q=$QUERY" 2>/dev/null | \\
  jq '[.results[] | {id, title, snippet: (.snippet | gsub("[[:cntrl:]]"; ""))}]' || {
  echo "ERROR: Cannot connect to backend at port $PORT (is the app running?)" >&2
  exit 1
}
`,
    },
    {
      name: 'kb-read-page.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Reads one Knowledge Base page as markdown.
# Usage: bash kb-read-page.sh <page_id>
RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"
[ -f "$RUNTIME_JSON" ] || { echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2; exit 1; }
PORT=$(jq -r .backend_port "$RUNTIME_JSON" 2>/dev/null)
[ -n "$PORT" ] && [ "$PORT" != "null" ] || { echo "ERROR: Cannot read backend_port from $RUNTIME_JSON" >&2; exit 1; }

PAGE_ID="\${1:-}"
[ -n "$PAGE_ID" ] || { echo "ERROR: Provide a page id. Usage: bash kb-read-page.sh <page_id>" >&2; exit 1; }

curl -s -w "\\n%{http_code}" "http://127.0.0.1:$PORT/knowledge/pages/$PAGE_ID" 2>/dev/null > /tmp/kb-read.out || {
  echo "ERROR: Cannot connect to backend at port $PORT" >&2; exit 1; }
HTTP_CODE=$(tail -1 /tmp/kb-read.out)
BODY=$(sed '$ d' /tmp/kb-read.out)
if [ "$HTTP_CODE" = "200" ]; then
  echo "$BODY" | jq '{id, title, icon, content_markdown}'
else
  echo "ERROR: Backend returned HTTP $HTTP_CODE" >&2; echo "$BODY" >&2; exit 1
fi
`,
    },
    {
      name: 'kb-create-page.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Creates a Knowledge Base page from a JSON file.
# The JSON may contain: title, parent_id (optional), icon (optional emoji),
# content_markdown (optional — the page body as markdown).
# Usage: bash kb-create-page.sh <json-file>
RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"
[ -f "$RUNTIME_JSON" ] || { echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2; exit 1; }
PORT=$(jq -r .backend_port "$RUNTIME_JSON" 2>/dev/null)
[ -n "$PORT" ] && [ "$PORT" != "null" ] || { echo "ERROR: Cannot read backend_port from $RUNTIME_JSON" >&2; exit 1; }

JSON_FILE="\${1:-}"
[ -n "$JSON_FILE" ] && [ -f "$JSON_FILE" ] || { echo "ERROR: Provide a path to a JSON file. Usage: bash kb-create-page.sh <json-file>" >&2; exit 1; }

RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://127.0.0.1:$PORT/knowledge/pages" \\
  -H "Content-Type: application/json" -d @"$JSON_FILE" 2>&1) || {
  echo "ERROR: Cannot connect to backend at port $PORT (is the app running?)" >&2; exit 1; }
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')
if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
  PAGE_TITLE=$(echo "$BODY_RESPONSE" | jq -r '.title // "Untitled"')
  PAGE_ID=$(echo "$BODY_RESPONSE" | jq -r '.id // "unknown"')
  echo "SUCCESS: Created Knowledge Base page '$PAGE_TITLE' (id: $PAGE_ID)"
else
  echo "ERROR: Backend returned HTTP $HTTP_CODE" >&2; echo "$BODY_RESPONSE" >&2; exit 1
fi
`,
    },
    {
      name: 'kb-update-page.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Updates an existing Knowledge Base page from a JSON file.
# The JSON may contain any of: title, icon, content_markdown.
# Writing content_markdown clears the stored block JSON so the editor
# re-renders from your markdown the next time the page is opened.
# Usage: bash kb-update-page.sh <page_id> <json-file>
RUNTIME_JSON="\${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json"
[ -f "$RUNTIME_JSON" ] || { echo "ERROR: Runtime info not found at $RUNTIME_JSON" >&2; exit 1; }
PORT=$(jq -r .backend_port "$RUNTIME_JSON" 2>/dev/null)
[ -n "$PORT" ] && [ "$PORT" != "null" ] || { echo "ERROR: Cannot read backend_port from $RUNTIME_JSON" >&2; exit 1; }

PAGE_ID="\${1:-}"
JSON_FILE="\${2:-}"
[ -n "$PAGE_ID" ] || { echo "ERROR: Provide a page id. Usage: bash kb-update-page.sh <page_id> <json-file>" >&2; exit 1; }
[ -n "$JSON_FILE" ] && [ -f "$JSON_FILE" ] || { echo "ERROR: Provide a JSON file as the second argument" >&2; exit 1; }

# When content_markdown is provided, also null out content_json so the editor
# reconverts from markdown on next open (markdown is the agent's source of truth).
BODY=$(jq 'if has("content_markdown") then . + {content_json: null} else . end' "$JSON_FILE")

RESPONSE=$(curl -s -w "\\n%{http_code}" -X PATCH "http://127.0.0.1:$PORT/knowledge/pages/$PAGE_ID" \\
  -H "Content-Type: application/json" -d "$BODY" 2>&1) || {
  echo "ERROR: Cannot connect to backend at port $PORT" >&2; exit 1; }
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')
if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
  echo "SUCCESS: Updated Knowledge Base page $PAGE_ID"
else
  echo "ERROR: Backend returned HTTP $HTTP_CODE" >&2; echo "$BODY_RESPONSE" >&2; exit 1
fi
`,
    },
    {
      name: 'list-experts.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Lists Cerebro experts from the backend API. When the caller scopes this
# run with CEREBRO_EXPERT_ALLOWLIST_SET=1, only experts whose id appears in
# CEREBRO_EXPERT_ALLOWLIST (comma-separated) are returned — used by the
# Slack bridge to enforce per-person expert access.
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

# The builtin "cerebro" expert is the orchestrator itself — exclude it from the
# delegation roster so the main agent never tries to delegate to itself.
if [ "\${CEREBRO_EXPERT_ALLOWLIST_SET:-}" = "1" ]; then
  ALLOW="\${CEREBRO_EXPERT_ALLOWLIST:-}"
  curl -s "http://127.0.0.1:$PORT/experts?is_enabled=true&limit=200" \\
    | jq --arg allow "$ALLOW" '.experts[] | select(.id != "cerebro") | select(($allow | split(",")) | index(.id) != null) | {id, name, slug, description}'
else
  curl -s "http://127.0.0.1:$PORT/experts?is_enabled=true&limit=200" | jq '.experts[] | select(.id != "cerebro") | {id, name, slug, description}'
fi
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
      name: 'list-tasks.sh',
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

# Optional first arg = column filter (backlog|in_progress|to_review|completed|error).
COLUMN="\${1:-}"
URL="http://127.0.0.1:$PORT/tasks"
if [ -n "$COLUMN" ]; then
  URL="$URL?column=$COLUMN"
fi

RESPONSE=$(curl -s -w "\\n%{http_code}" "$URL" 2>&1) || {
  echo "ERROR: Cannot connect to backend at port $PORT (is the app running?)" >&2
  exit 1
}

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')

if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
  COUNT=$(echo "$BODY_RESPONSE" | jq 'length')
  echo "SUCCESS: Retrieved $COUNT task(s)."
  # Compact projection — the fields the agent needs to filter by date and report.
  echo "$BODY_RESPONSE" | jq '[.[] | {id, title, column, priority, expert_id, created_at, due_at, started_at, completed_at}]'
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
# engine. Pauses for human approval before the action executes — the call below
# blocks until the user clicks Approve or Deny in the Approvals tab, then prints
# the structured result. (Exception: if the user has set a "don't ask again"
# auto-approval rule covering this action — its destination, its action type, or
# its integration — the action runs immediately and the call returns without pausing.)
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

# Stamp the originating conversation id (exported by the bridge/runtime as
# CEREBRO_CONVERSATION_ID) onto the request body so the engine can route the
# approval back to the exact Slack/Telegram thread that triggered it. Falls
# back to the raw body when the variable is unset (e.g. desktop chat).
PAYLOAD=$(cat "$JSON_FILE")
if [ -n "\${CEREBRO_CONVERSATION_ID:-}" ]; then
  PAYLOAD=$(echo "$PAYLOAD" | jq --arg cid "\${CEREBRO_CONVERSATION_ID}" '. + {conversation_id: $cid}') || {
    echo "ERROR: Failed to stamp conversation id onto request body" >&2
    exit 1
  }
fi

# Long-poll: this curl call sits open until the user resolves the approval
# (or the underlying run reaches a terminal state). Increase max-time to 30
# minutes so a slow human reviewer doesn't trip the curl timeout.
RESPONSE=$(curl -s --max-time 1800 -w "\\n%{http_code}" \\
  -X POST "http://127.0.0.1:$PORT/chat-actions/run" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d "$PAYLOAD" 2>&1) || {
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
      name: 'manage-auto-approvals.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Manage "don't ask again" auto-approval rules. A rule lets a write/send skip the
# approval gate. Scope is set by the (action_type, target_key) pair:
#   - destination: action_type=<send action>, target_key=<channel/chat/phone id>
#   - action type: action_type=<action>,      target_key="*"
#   - module:      action_type="module:<group>", target_key="*"
# Anything not covered by a rule still pauses the first time. Rules persist across
# restarts and are revocable here or in the Approvals tab.
#
# Usage:
#   bash manage-auto-approvals.sh add <action_type> <target_key> [target_label]
#   bash manage-auto-approvals.sh revoke <action_type> <target_key>
#   bash manage-auto-approvals.sh list
#
#   <action_type>  chat action (e.g. send_slack_message, hubspot_create_ticket)
#                  or a module token (e.g. module:hubspot)
#   <target_key>   destination id (Slack channel C…/G…/D…, Telegram chat_id,
#                  WhatsApp phone) or "*" for any destination (action/module scope)
#   <target_label> optional human label for the UI, e.g. "#general" or "HubSpot"
#
# Exit codes: 0 success · 1 failure

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

BASE="http://127.0.0.1:$PORT/chat-actions/auto-approvals"
CMD="\${1:-}"

post_json() { # $1=url  $2=json-body
  curl -s --max-time 30 -w "\\n%{http_code}" \\
    -X POST "$1" \\
    -H "Authorization: Bearer $TOKEN" \\
    -H "Content-Type: application/json" \\
    -d "$2" 2>&1
}

case "$CMD" in
  add)
    ACTION_TYPE="\${2:-}"; TARGET_KEY="\${3:-}"; TARGET_LABEL="\${4:-}"
    if [ -z "$ACTION_TYPE" ] || [ -z "$TARGET_KEY" ]; then
      echo "ERROR: Usage: manage-auto-approvals.sh add <action_type> <target_key> [target_label]" >&2
      exit 1
    fi
    PAYLOAD=$(jq -n --arg a "$ACTION_TYPE" --arg t "$TARGET_KEY" --arg l "$TARGET_LABEL" \\
      '{action_type:$a, target_key:$t} + (if $l == "" then {} else {target_label:$l} end)')
    RESPONSE=$(post_json "$BASE" "$PAYLOAD") || { echo "ERROR: Cannot reach chat-actions server" >&2; exit 1; }
    ;;
  revoke)
    ACTION_TYPE="\${2:-}"; TARGET_KEY="\${3:-}"
    if [ -z "$ACTION_TYPE" ] || [ -z "$TARGET_KEY" ]; then
      echo "ERROR: Usage: manage-auto-approvals.sh revoke <action_type> <target_key>" >&2
      exit 1
    fi
    PAYLOAD=$(jq -n --arg a "$ACTION_TYPE" --arg t "$TARGET_KEY" '{action_type:$a, target_key:$t}')
    RESPONSE=$(post_json "$BASE/revoke" "$PAYLOAD") || { echo "ERROR: Cannot reach chat-actions server" >&2; exit 1; }
    ;;
  list)
    RESPONSE=$(curl -s --max-time 30 -w "\\n%{http_code}" \\
      -X GET "$BASE" -H "Authorization: Bearer $TOKEN" 2>&1) || { echo "ERROR: Cannot reach chat-actions server" >&2; exit 1; }
    ;;
  *)
    echo "ERROR: Unknown command '\${CMD}'. Use: add | revoke | list" >&2
    exit 1
    ;;
esac

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')

if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
  case "$CMD" in
    add)
      LABEL=$(echo "$BODY_RESPONSE" | jq -r '.rule.target_label // .rule.target_key // ""')
      echo "SUCCESS: Auto-approval enabled for $ACTION_TYPE → \${LABEL}"
      ;;
    revoke)
      DELETED=$(echo "$BODY_RESPONSE" | jq -r '.deleted // 0')
      echo "SUCCESS: Removed $DELETED auto-approval rule(s) for $ACTION_TYPE → $TARGET_KEY"
      ;;
    list)
      echo "SUCCESS: Auto-approval rules"
      echo "$BODY_RESPONSE" | jq '.rules // []'
      ;;
  esac
  exit 0
else
  ERROR=$(echo "$BODY_RESPONSE" | jq -r '.error // ""' 2>/dev/null)
  echo "ERROR: \${ERROR:-request failed} (HTTP $HTTP_CODE)" >&2
  exit 1
fi
`,
    },
    {
      name: 'propose-integration.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Asks the Cerebro UI to render an inline IntegrationSetupCard so the user
# can connect an integration (Telegram, Slack, HubSpot, WhatsApp, GoHighLevel, …)
# without leaving chat. The renderer owns credential entry — this script
# never transmits secrets and the chat agent must not ask for tokens in chat.
#
# Usage: bash propose-integration.sh <integration_id> [reason]
#
# integration_id must match a manifest in src/integrations/registry.ts.
# Currently: telegram | slack | hubspot | whatsapp | ghl | github | calendar.

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
  echo "ERROR: integration_id is required (e.g. telegram, slack, hubspot, whatsapp, ghl, github, calendar, n8n)" >&2
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
    {
      name: 'attach-expert-context.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Permanently attaches a file to an existing expert as a reference or template.
# Use when the user says an expert should ALWAYS use a given document as
# guide/format. For a one-off context pass (a diagram for THIS manual only),
# pass the file directly in the Agent call instead — do not use this script.
#
# Usage: bash attach-expert-context.sh <expert_id> <file_path> <kind>
#   kind: "template" (output MUST follow this format) | "reference" (background)
#
# The script registers the file with the backend's FileItem table (idempotent
# by sha+path) and then attaches it to the expert's context-files list.

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

EXPERT_ID="\${1:-}"
FILE_PATH="\${2:-}"
KIND="\${3:-}"
if [ -z "$EXPERT_ID" ] || [ -z "$FILE_PATH" ] || [ -z "$KIND" ]; then
  echo "Usage: bash attach-expert-context.sh <expert_id> <file_path> <kind>" >&2
  echo "  kind: template | reference" >&2
  exit 1
fi

if [ "$KIND" != "template" ] && [ "$KIND" != "reference" ]; then
  echo "ERROR: kind must be 'template' or 'reference' (got: $KIND)" >&2
  exit 1
fi

if [ ! -f "$FILE_PATH" ]; then
  echo "ERROR: File not found: $FILE_PATH" >&2
  exit 1
fi

ABS_PATH=$(cd "$(dirname "$FILE_PATH")" && pwd)/$(basename "$FILE_PATH")

# Step 1: Register the file with the backend (idempotent — returns existing
# row if same sha+path+source already exist).
REG_BODY=$(jq -n --arg file_path "$ABS_PATH" '{file_path: $file_path, source: "expert-context"}')
REG_RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://127.0.0.1:$PORT/files/items/from-path" \\
  -H "Content-Type: application/json" \\
  -d "$REG_BODY" 2>&1) || {
  echo "ERROR: Cannot connect to backend at port $PORT (is the app running?)" >&2
  exit 1
}

REG_CODE=$(echo "$REG_RESPONSE" | tail -1)
REG_BODY_RESPONSE=$(echo "$REG_RESPONSE" | sed '$ d')

if [ "$REG_CODE" -lt 200 ] 2>/dev/null || [ "$REG_CODE" -ge 300 ] 2>/dev/null; then
  echo "ERROR: Could not register file (HTTP $REG_CODE)" >&2
  echo "$REG_BODY_RESPONSE" >&2
  exit 1
fi

FILE_ITEM_ID=$(echo "$REG_BODY_RESPONSE" | jq -r '.id // ""')
if [ -z "$FILE_ITEM_ID" ]; then
  echo "ERROR: Backend did not return a file id" >&2
  exit 1
fi

# Step 2: Attach the FileItem to the expert.
ATTACH_BODY=$(jq -n --arg fid "$FILE_ITEM_ID" --arg kind "$KIND" '{file_item_id: $fid, kind: $kind}')
ATTACH_RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://127.0.0.1:$PORT/experts/$EXPERT_ID/context-files" \\
  -H "Content-Type: application/json" \\
  -d "$ATTACH_BODY" 2>&1) || {
  echo "ERROR: Cannot connect to backend at port $PORT" >&2
  exit 1
}

ATTACH_CODE=$(echo "$ATTACH_RESPONSE" | tail -1)
ATTACH_BODY_RESPONSE=$(echo "$ATTACH_RESPONSE" | sed '$ d')

if [ "$ATTACH_CODE" -ge 200 ] 2>/dev/null && [ "$ATTACH_CODE" -lt 300 ] 2>/dev/null; then
  CTX_ID=$(echo "$ATTACH_BODY_RESPONSE" | jq -r '.id // "unknown"')

  # Step 3: Re-render the expert's .md so the new context file is visible to
  # the subagent on the NEXT turn — not only after the user restarts the app.
  # The backend /sync/agent-files endpoint mirrors the TS installer's
  # buildExpertBody including reference documents, so the .md picks up the
  # template immediately. We surface a WARN (not ERROR) on failure: the
  # attach itself is already persisted, so the user shouldn't see a hard
  # failure — restarting the app would still pick it up.
  SYNC_RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://127.0.0.1:$PORT/sync/agent-files" 2>&1) || {
    echo "SUCCESS: Attached file as $KIND to expert $EXPERT_ID (context-file id: $CTX_ID)"
    echo "WARN: could not reach /sync/agent-files — expert .md may be stale until restart" >&2
    echo "$ATTACH_BODY_RESPONSE" | jq .
    exit 0
  }
  SYNC_CODE=$(echo "$SYNC_RESPONSE" | tail -1)

  echo "SUCCESS: Attached file as $KIND to expert $EXPERT_ID (context-file id: $CTX_ID)"
  if [ "$SYNC_CODE" -lt 200 ] 2>/dev/null || [ "$SYNC_CODE" -ge 300 ] 2>/dev/null; then
    echo "WARN: /sync/agent-files returned HTTP $SYNC_CODE — expert .md may be stale until restart" >&2
  fi
  echo "$ATTACH_BODY_RESPONSE" | jq .
else
  echo "ERROR: Backend returned HTTP $ATTACH_CODE" >&2
  echo "$ATTACH_BODY_RESPONSE" >&2
  exit 1
fi
`,
    },
    {
      name: 'update-expert.sh',
      content: `#!/usr/bin/env bash
set -euo pipefail

# Updates an existing expert's name, description, and/or system_prompt via
# PATCH /experts/{id}. Verified (built-in) experts only accept toggles
# (is_enabled, is_pinned) and the backend will return HTTP 403 for any
# attempt to change persona fields on them.
#
# Usage: bash update-expert.sh <expert_id> <json-file>
#   The JSON file may contain any subset of: name, description, system_prompt.
#   (For verified experts only: is_enabled, is_pinned.)

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

EXPERT_ID="\${1:-}"
JSON_FILE="\${2:-}"
if [ -z "$EXPERT_ID" ] || [ -z "$JSON_FILE" ] || [ ! -f "$JSON_FILE" ]; then
  echo "Usage: bash update-expert.sh <expert_id> <json-file>" >&2
  exit 1
fi

RESPONSE=$(curl -s -w "\\n%{http_code}" -X PATCH "http://127.0.0.1:$PORT/experts/$EXPERT_ID" \\
  -H "Content-Type: application/json" \\
  -d @"$JSON_FILE" 2>&1) || {
  echo "ERROR: Cannot connect to backend at port $PORT (is the app running?)" >&2
  exit 1
}

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$ d')

if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
  EXPERT_NAME=$(echo "$BODY_RESPONSE" | jq -r '.name // "unknown"')
  echo "SUCCESS: Updated expert '$EXPERT_NAME' (id: $EXPERT_ID)"
  echo "$BODY_RESPONSE" | jq .
elif [ "$HTTP_CODE" = "403" ]; then
  DETAIL=$(echo "$BODY_RESPONSE" | jq -r '.detail // ""')
  echo "ERROR: \${DETAIL:-Cannot modify this expert (likely a built-in/verified one)} (HTTP 403)" >&2
  exit 1
elif [ "$HTTP_CODE" = "404" ]; then
  echo "ERROR: Expert $EXPERT_ID not found (HTTP 404)" >&2
  exit 1
else
  echo "ERROR: Backend returned HTTP $HTTP_CODE" >&2
  echo "$BODY_RESPONSE" >&2
  exit 1
fi
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
      name: 'knowledge-base',
      description:
        'Read from and write to the Knowledge Base (Notion-style pages app). Use when the user asks to look something up in, find, create, add, or update a Knowledge Base / wiki / docs page, or save notes as a page. Spanish: "busca en la base de conocimiento", "crea una página", "guarda esto como una nota/página", "añade a la base de conocimiento".',
      body: `# Knowledge Base

The Knowledge Base is Cerebro's built-in Notion-style notes app: a tree of pages (a "folder" is just a page with children). You work in **markdown** — never touch the editor's internal block JSON. All commands run with the **Bash** tool.

## Search pages (do this first when looking something up)
\`\`\`bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/kb-search.sh" "your search terms"
\`\`\`
Returns relevance-ranked \`{id, title, snippet}\` matches across page titles **and** bodies. This is the right tool when the user asks "what does my knowledge base say about X" or "find the page about Y" — search by keyword rather than guessing from titles. Then \`kb-read-page.sh\` the most relevant id(s) for full content.

## List pages
\`\`\`bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/kb-list-pages.sh"
\`\`\`
Returns a flat array of \`{id, title, parent_id}\`. Use it to browse the whole structure (e.g. before creating something new); prefer \`kb-search.sh\` when you're looking for specific content.

## Read a page
\`\`\`bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/kb-read-page.sh" <page_id>
\`\`\`
Returns the page's \`title\`, \`icon\`, and \`content_markdown\`.

## Create a page
Build the JSON first, then run the script. \`content_markdown\` is the page body; \`parent_id\` (optional) nests it under another page; \`icon\` (optional) is a single emoji.
\`\`\`bash
jq -n \\
  --arg title "REPLACE_TITLE" \\
  --arg icon "📝" \\
  --arg md "REPLACE_MARKDOWN_BODY" \\
  '{title: $title, icon: $icon, content_markdown: $md}' \\
  > "$CLAUDE_PROJECT_DIR/.claude/tmp/kb-new-page.json" && \\
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/kb-create-page.sh" "$CLAUDE_PROJECT_DIR/.claude/tmp/kb-new-page.json"
\`\`\`
To nest under an existing page, add \`parent_id: $parent\` (with \`--arg parent "<id>"\`) to the jq object.

## Update a page
\`\`\`bash
jq -n --arg md "REPLACE_MARKDOWN_BODY" '{content_markdown: $md}' \\
  > "$CLAUDE_PROJECT_DIR/.claude/tmp/kb-update.json" && \\
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/kb-update-page.sh" <page_id> "$CLAUDE_PROJECT_DIR/.claude/tmp/kb-update.json"
\`\`\`

## Notes
- Write normal markdown: \`#\`/\`##\`/\`###\` headings, \`-\` and \`1.\` lists, \`- [ ]\` checkboxes, \`>\` quotes, fenced code blocks, tables, and images. The editor converts your markdown into rich blocks when the page is opened.
- On **SUCCESS**, tell the user the page is ready and where to find it (Apps → Knowledge Base). On **ERROR**, report what failed.
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

If the output says **SUCCESS**, capture the new expert's id from the JSON output — you need it in the next step.
If the output says **ERROR**, report the error to the user and stop here.

## After SUCCESS — handle any files the user attached during setup

Before announcing the expert to the user, check whether the same message (or the most recent few messages framing the expert setup) contained \`@/absolute/path\` attachment lines. If yes, those files are part of the expert's *configuration* — they must be persisted, not used as one-off context. The user has already done the work of attaching them; do not make them re-upload.

For each attached file, do not invoke \`attach-expert-context.sh\` blindly. Instead:

1. **Ask once, consolidated.** If there is one file, ask: *"You attached \`<file>\` while setting up \`<expert_name>\` — should I attach it as a **template** (every future output must follow this format) or a **reference** (background knowledge only)? Or **skip** — it was only for the first task."* If there are multiple files, list them and ask per-file in the same message.
2. **On a yes**, run \`attach-expert-context.sh\` per file with the chosen \`KIND\`. The script auto-re-renders the expert .md, so no extra rematerialize call is needed.
3. **On skip or no reply yet**, do not attach.

Only after this step — once any attachments are saved (or explicitly skipped) — tell the user the expert is ready. Mention which files were attached and as which kind. If you set a domain on creation, also mention that matching skills from the library were auto-assigned.
`,
    },
    {
      name: 'attach-expert-context',
      description:
        'Permanently attach a document to an existing expert as a template (output must follow this format) or reference (background knowledge). Use whenever the user wants the file to persist for future turns — including the implicit case where they are *configuring* an expert and attach a template/reference.',
      body: `# Attach expert context

Use this skill when the user wants an existing expert to use a specific document on future turns. Two common shapes:

- **Explicit:** "siempre entrégame manuales en este formato", "use this as the template for every report", "ten siempre presente este documento", "always remember this brand guideline".
- **Configuration intent:** the user is setting up or configuring an expert and attaches a file (\`@/path\`) as part of the setup — *"vamos a configurar al manual-writer, usa este formato"*, *"let's set this expert up with this template"*. Do **not** treat configuration attachments as one-off context; they are part of the expert's persistent setup.

**Do not use this skill for genuinely one-off context.** If the user attached a diagram for THIS manual only, pass the file directly in your \`Agent\` call instead — the expert will read it for that single turn.

## Decide the kind

- **\`template\`** — the user wants future deliverables to **follow the file's structure / format / layout exactly**. Headers, sections, page format, branding, etc. (Cerebro injects it into the expert with a "your output MUST follow this format" instruction.)
- **\`reference\`** — the user wants the expert to **know about** the file's content (brand guide, FAQ, product spec) but isn't dictating output structure.

When in doubt, ask one short clarifier: *"I'll attach \`<file>\` to \`<expert>\` as a **template** (every output must follow this format) — or **reference** (background knowledge). Which?"* Wait for the answer before invoking.

## Workflow

1. **Identify the expert.** Run \`list-experts\` if you don't already know the expert_id.
2. **Identify the file.** The user attached the file in the current message or in an earlier turn — its absolute path is in the message as an \`@/absolute/path\` line. Use that exact path. If the path was dropped from conversation history, ask the user to re-attach it once.
3. **Confirm in one sentence.** "I'll attach \`<filename>\` to \`<expert>\` as a \`<kind>\` — every future turn that expert will use it. Confirm?" Wait for a yes.
4. **Invoke.** Replace the three placeholders and run:

\`\`\`bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/attach-expert-context.sh" "EXPERT_ID" "/absolute/path/to/file" "KIND"
\`\`\`

Where \`KIND\` is exactly \`template\` or \`reference\`. The script registers the file, attaches it, **and** re-renders the expert's agent file so the new context is live on the next turn — you do **not** need to call \`rematerialize-experts.sh\` separately.

## Result

- **SUCCESS** — tell the user it's saved and the expert will use it on every future turn from now on. Do not re-run the task in the same turn unless the user asked for it.
- **SUCCESS … WARN: …** — the attach itself succeeded; only the live re-render failed. Tell the user the file is saved and the expert will pick it up on the next app start; if they want it active *right now* without restart, surface the WARN verbatim so they can report it.
- **ERROR** — surface the message verbatim. The most likely cause is that the path is wrong or the expert id is wrong; verify with \`list-experts\`.
`,
    },
    {
      name: 'update-expert',
      description:
        "Modify an existing expert's name, description, or system prompt via the backend. Use ONLY when the user explicitly asks to change the expert itself — never when they ask the expert to do work.",
      body: `# Update expert

Use this skill **only** when the user explicitly asks to change an existing expert — its persona, system prompt, name, or description.

Trigger phrases (EN): "change the prompt for expert X", "update expert X's instructions", "rename expert X to Y", "edit expert X's description", "make expert X more formal".
Trigger phrases (ES): "modifica el prompt del experto X", "actualiza las instrucciones del experto X", "cambia la descripción del experto X", "renombra al experto X", "haz al experto X más formal".

**Never use this skill when the user asks the expert to do work** (create something, answer something, run something). That is delegation via the \`Agent\` tool. *"Use the manual-writer to create a manual from this diagram"* is **delegation**, not an update. *"Make the manual-writer always include a glossary section"* is also tricky — that's either an \`attach-expert-context\` (template file) or an \`update-expert\` depending on whether the user is providing a file. If the request is ambiguous, ask one short clarifier.

## Workflow

1. **Find the expert.** Run \`list-experts\` if you don't already know the expert_id.
2. **Decide the changes.** Any subset of \`name\`, \`description\`, \`system_prompt\` can be updated in one call.
3. **Confirm the new wording.** Show the user the proposed value(s) in your reply and ask for an explicit yes before invoking. For \`system_prompt\` changes, show the full new prompt so they can read it.
4. **Note: verified experts are locked.** Cerebro's built-in experts cannot be modified — the backend returns HTTP 403. If that happens, suggest the user clone the expert via the Experts screen and edit the copy.
5. **Invoke.** Build a JSON file containing only the fields that are changing, then run:

\`\`\`bash
jq -n \\
  --arg name "NEW_NAME_OR_OMIT" \\
  --arg description "NEW_DESCRIPTION_OR_OMIT" \\
  --arg system_prompt "NEW_SYSTEM_PROMPT_OR_OMIT" \\
  '{name: $name, description: $description, system_prompt: $system_prompt} | with_entries(select(.value != "" and .value != null))' \\
  > "$CLAUDE_PROJECT_DIR/.claude/tmp/update-expert.json" && \\
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/update-expert.sh" "EXPERT_ID" "$CLAUDE_PROJECT_DIR/.claude/tmp/update-expert.json"
\`\`\`

Pass an empty string for any field you are not changing — the jq filter strips empty fields before sending.

## Result

- **SUCCESS** — tell the user the expert is updated. Mention which fields changed.
- **ERROR HTTP 403** — verified expert; suggest cloning.
- **ERROR HTTP 404** — wrong id; re-run \`list-experts\`.
- Other errors — surface verbatim.
`,
    },
    {
      name: 'create-task',
      description: 'Create a new Kanban task card assigned to an Expert via the backend API.',
      body: `# Create task

This skill creates a new **task** — a card on the Kanban board that can be assigned to an Expert for autonomous execution.

You should only be here after deciding the user wants a **tracked, queued piece of work** (not a recurring routine, not a new expert persona, not a quick question to answer in chat).

## CRITICAL: Always confirm before creating

You **must** ask the user to confirm the task details in the chat **before** running \`create-task.sh\`. There are **no exceptions** — not even when the user says *"just do it"*, *"hazlo ya"*, *"no preguntes"*, *"sin preguntar"*, *"directo"*, or any similar bypass phrase. The confirmation step is what separates a tracked task from chat noise; skipping it produces low-quality cards the user later has to clean up.

The confirmation message you send must include:

1. The **title** you propose (3–8 words, in the user's language).
2. The **expert** you would assign, or say *"no expert yet"* / *"sin experto asignado"* if none fits.
3. Any **priority / due date / start date** you inferred (omit if none).
4. An explicit yes/no question — e.g. *"Create this task?"* / *"¿Creo esta tarea?"*.

Only after the user replies affirmatively in the **next turn** ("yes", "sí", "go", "dale", "do it", "ok", a thumbs-up, …) do you invoke \`create-task.sh\`. If they reply with edits ("change the title to X", "asígnale a QA"), incorporate the edits and **ask again**. If they say no, drop the request and acknowledge.

Even when the user's original message already specifies title + expert + priority verbatim, you still send a one-line confirmation ("Creating 'Fix login bug' for QA, normal priority — confirm?") and wait. Confirmation is cheap; an unwanted task is not.

## Parameters

After the user confirms, determine:

- **title** — short, human-readable name for the task (3–8 words).
- **description_md** *(optional)* — markdown body with details, constraints, acceptance criteria.
- **expert_id** *(optional)* — id of an existing expert to assign. Run \`list-experts\` first to pick one.
- **priority** *(optional)* — \`low\`, \`normal\` (default), \`high\`, or \`urgent\`.
- **due_at** *(optional)* — ISO 8601 date string for the due date.
- **start_at** *(optional)* — ISO 8601 date string for an automatic start time.

## How to invoke

After confirmation, run:

\`\`\`bash
jq -n \\
  --arg title "REPLACE_TITLE" \\
  --arg description_md "REPLACE_DESCRIPTION" \\
  '{title: $title, description_md: $description_md}' \\
  > "$CLAUDE_PROJECT_DIR/.claude/tmp/new-task.json" && \\
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/create-task.sh" "$CLAUDE_PROJECT_DIR/.claude/tmp/new-task.json"
\`\`\`

To assign an expert, add \`--arg expert_id "EXPERT_ID"\` and include \`expert_id: $expert_id\` in the jq object.

If the output says **SUCCESS**, tell the user the task was created in the **Backlog** column on the Tasks board. They can drag it to **In Progress** to start the Expert.
If the output says **ERROR**, report the error to the user.

## Worked examples

### English — confirm-then-create

> **User:** can you make a task to refactor the auth module
>
> **You:** I'll create a task **"Refactor auth module"** with no expert assigned yet, normal priority. Create it?
>
> **User:** yes
>
> *(now run create-task.sh)*
>
> **You:** Done — "Refactor auth module" is in the **Backlog** column. Drag it to **In Progress** to start the Expert.

### Spanish — bypass phrase still requires confirmation

> **Usuario:** hazlo ya, crea la tarea de migrar la base de datos
>
> **Tú:** Voy a crear la tarea **"Migrar base de datos"** sin experto asignado, prioridad normal. ¿La creo?
>
> **Usuario:** sí, dale
>
> *(ahora ejecuta create-task.sh)*
>
> **Tú:** Listo — "Migrar base de datos" está en la columna **Backlog**. Arrástrala a **In Progress** para iniciar al Experto.

### Counter-example — do NOT do this

> **User:** create a task for the login bug, just do it, don't ask
>
> **You (WRONG):** *(invokes create-task.sh immediately)*
>
> **You (RIGHT):** Quick check — title **"Fix login bug"**, no expert yet, normal priority. Confirm and I'll create it?
`,
    },
    {
      name: 'list-tasks',
      description:
        'List existing Kanban task cards from the backend, with an optional column filter. Read-only.',
      body: `# List tasks

This skill reads the **tasks** on the Kanban board (the cards created via \`create-task\` and shown on the Tasks screen). Use it whenever the user wants to *see* their tasks rather than create one.

This is **read-only** — no confirmation needed. Just run it and report.

## When to use

Match requests like (English **or** Spanish):

- "what tasks do I have", "list my tasks", "show the tasks", "listar tareas", "qué tareas tengo"
- "tasks created today", "tareas de hoy", "qué tareas se crearon hoy"
- "tasks due today", "tareas que vencen hoy", "qué tareas vencen hoy"
- "what's in progress", "tareas pendientes", "tareas en progreso", "qué hay en revisión"

## How to invoke

All tasks:

\`\`\`bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/list-tasks.sh"
\`\`\`

Filter by column (one of \`backlog\`, \`in_progress\`, \`to_review\`, \`completed\`, \`error\`):

\`\`\`bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/list-tasks.sh" in_progress
\`\`\`

The script prints \`SUCCESS: Retrieved N task(s).\` followed by a JSON array. Each task has \`id\`, \`title\`, \`column\`, \`priority\`, \`expert_id\`, \`created_at\`, \`due_at\`, \`started_at\`, \`completed_at\`.

## Filtering by date — you do this yourself

The script does **not** filter by date; it returns every task (or every task in a column). For "created today" / "due today" requests, fetch the list and filter in your head:

- \`created_at\` and \`due_at\` are ISO-8601 timestamps in **UTC**.
- Compare the **calendar date** portion against the user's current local day (today's date is given to you in context). "Created today" = \`created_at\` falls on today; "due today" = \`due_at\` falls on today.

## Reporting

Present a concise list — title, column, priority, and due date when present. If \`SUCCESS: Retrieved 0\` or nothing matches the date filter, say so plainly ("No tienes tareas creadas hoy." / "You have no tasks created today.") rather than inventing entries. Reply in the user's language. On \`ERROR\`, surface the message.
`,
    },
    {
      name: 'run-chat-action',
      description:
        'Invoke a connected integration action (HubSpot, Telegram, Slack, WhatsApp, …) directly from chat. Pauses for human approval unless the user has set a "don\'t ask again" rule for that exact destination.',
      body: `# Run chat action

Use this skill whenever the user asks Cerebro to **do** something through a connected integration — anything that touches an external service (HubSpot, Telegram, Slack, WhatsApp, HTTP endpoints, desktop notifications, and any future integrations like GitHub or iMessage).

The user may speak in **English or Spanish** (or mix them). Recognize natural-language intents and map them to the correct action \`type\`:

| User says (EN / ES) | Action type |
| --- | --- |
| "Create a HubSpot ticket about X" / "Crea un ticket de HubSpot sobre X" | \`hubspot_create_ticket\` |
| "Create a HubSpot ticket about X and link it to juan@…" / "Crea un ticket de HubSpot sobre X y asócialo a juan@…" | \`hubspot_create_ticket\` (pass \`contact_email\`) |
| "Create a HubSpot ticket about X and assign it to María" / "Crea un ticket de HubSpot sobre X y asígnalo a María" | \`hubspot_create_ticket\` (pass \`owner\`) |
| "Create a HubSpot ticket due 2026-06-10 with follow-up juan@…" / "Crea un ticket de HubSpot con vencimiento 2026-06-10 y seguimiento a juan@…" | \`hubspot_create_ticket\` (pass \`due_date\`, \`follow_up_user\`) |
| "Reassign HubSpot ticket 12345 to juan@…" / "Reasigna el ticket 12345 de HubSpot a juan@…" | \`hubspot_update_ticket\` (pass \`owner\`) |
| "Set the due date of HubSpot ticket 12345 to 2026-06-10" / "Pon la fecha de vencimiento del ticket 12345 al 2026-06-10" | \`hubspot_update_ticket\` (pass \`due_date\`) |
| "Add Maria to HubSpot" / "Agrega a María a HubSpot" | \`hubspot_upsert_contact\` |
| "Is juan@… a contact in HubSpot?" / "¿Está juan@… como contacto en HubSpot?" | \`hubspot_search_contact\` |
| "List the HubSpot tickets created today" / "Lista los tickets de HubSpot creados hoy" | \`hubspot_search_tickets\` |
| "Show me the open HubSpot tickets" / "Muéstrame los tickets de HubSpot abiertos" | \`hubspot_search_tickets\` |
| "Which company / contact is HubSpot ticket 12345 from?" / "¿De qué empresa / contacto es el ticket 12345 de HubSpot?" | \`hubspot_get_ticket\` |
| "Change HubSpot ticket 12345 priority to High" / "Cambia la prioridad del ticket 12345 de HubSpot a alta" | \`hubspot_update_ticket\` |
| "Move HubSpot ticket 12345 to the Waiting stage" / "Mueve el ticket 12345 de HubSpot a la etapa En espera" | \`hubspot_update_ticket\` |
| "List my HubSpot companies / deals" / "Lista mis empresas / negocios de HubSpot" | \`hubspot_list_objects\` (\`object_type\`) |
| "Add the company Acme (acme.com) to HubSpot" / "Agrega la empresa Acme (acme.com) a HubSpot" | \`hubspot_create_object\` (\`object_type: companies\`) |
| "Create a HubSpot deal called Q3 Renewal for 5000" / "Crea un negocio llamado Renovación Q3 por 5000" | \`hubspot_create_object\` (\`object_type: deals\`) |
| "Update the deal 12345 amount to 8000" / "Actualiza el monto del negocio 12345 a 8000" | \`hubspot_update_object\` (\`object_type: deals\`) |
| "Delete company 678 from HubSpot" / "Elimina la empresa 678 de HubSpot" | \`hubspot_delete_object\` |
| "List my HubSpot lists / segments" / "Lista mis listas / segmentos de HubSpot" | \`hubspot_list_lists\` |
| "Create a HubSpot list called VIP" / "Crea una lista de HubSpot llamada VIP" | \`hubspot_create_list\` |
| "Rename HubSpot list 42 to Top accounts" / "Renombra la lista 42 a Cuentas top" | \`hubspot_update_list\` |
| "Delete HubSpot list 42" / "Elimina la lista 42 de HubSpot" | \`hubspot_delete_list\` |
| "Add contact 789 to the VIP list 42" / "Añade el contacto 789 a la lista VIP 42" | \`hubspot_list_membership\` (\`mode: add\`) |
| "Send Pablo a Telegram" / "Envíale un Telegram a Pablo" | \`send_telegram_message\` |
| "Post in #general on Slack saying X" / "Publica en #general en Slack diciendo X" | \`send_slack_message\` |
| "DM @Pablo on Slack about X" / "Mándale un DM a @Pablo por Slack sobre X" | \`send_slack_message\` (use the DM channel id, D…) |
| "Send the report.pdf to #reports on Slack" / "Manda el report.pdf a #reportes en Slack" | \`send_slack_file\` |
| "Which Slack channels can Cerebro post to?" / "¿En qué canales de Slack puede publicar Cerebro?" | \`list_slack_channels\` |
| "Send a WhatsApp to +1…" / "Envía un WhatsApp a +1…" | \`send_whatsapp_message\` |
| "Open a GitHub issue on owner/repo titled X" / "Abre un issue de GitHub en owner/repo titulado X" | \`github_create_issue\` |
| "Comment on issue #N in owner/repo: …" / "Comenta en el issue #N de owner/repo: …" | \`github_comment_issue\` |
| "Comment on PR #N in owner/repo: …" / "Comenta en el PR #N de owner/repo: …" | \`github_comment_pr\` |
| "Review PR #N in owner/repo and approve/request changes saying X" / "Revisa el PR #N en owner/repo y aprueba/pide cambios diciendo X" | \`github_review_pr\` |
| "Open a PR on owner/repo from feat/X to main titled Y" / "Abre un PR en owner/repo desde feat/X hacia main titulado Y" | \`github_open_pr\` |
| "Create a meeting with John tomorrow at 2 for 30 min" / "Crea una reunión con John mañana a las 2 por 30 min" | \`calendar_create_event\` |
| "Move my 3pm to Friday" / "Mueve mi reunión de las 3pm al viernes" | \`calendar_query_events\` to find the id, then \`calendar_update_event\` |
| "Cancel my 4pm today" / "Cancela mi reunión de las 4pm de hoy" | \`calendar_query_events\` then \`calendar_delete_event\` |
| "Decline the budget review invite" / "Rechaza la invitación de revisión de presupuesto" | \`calendar_query_events\` then \`calendar_rsvp\` |
| "What does my week look like?" / "¿Cómo se ve mi semana?" | \`calendar_query_events\` |
| "Find 30 minutes next week for Sarah" / "Encuentra 30 minutos la próxima semana para Sarah" | \`calendar_find_free_time\` |
| "Did Acme reply about the invoice?" / "¿Acme respondió sobre la factura?" | \`gmail_search_messages\` |
| "Find the email from Alice with the contract" / "Busca el correo de Alice con el contrato" | \`gmail_search_messages\` |
| "What did that thread with Acme say?" / "¿Qué decía ese hilo con Acme?" | \`gmail_get_thread\` |
| "When did I last email carlos@acme.com?" / "¿Cuándo fue mi último correo con carlos@acme.com?" | \`gmail_get_contact_history\` |
| "Send an email to alice@acme.com about X" / "Envía un correo a alice@acme.com sobre X" | \`gmail_send_message\` |
| "Reply to that email saying we accept" / "Responde a ese correo diciendo que aceptamos" | \`gmail_send_message\` (\`reply_to_thread_id\`) |
| "Draft an email to Alice, don't send it" / "Prepara un borrador para Alice, no lo envíes" | \`gmail_create_draft\` |
| "Archive those newsletters" / "Archiva esos boletines" | \`gmail_modify_labels\` (\`remove_labels: INBOX\`) |
| "Mark that email as read" / "Marca ese correo como leído" | \`gmail_modify_labels\` (\`remove_labels: UNREAD\`) |
| "Who hasn't replied to my emails?" / "¿Quién no ha respondido a mis correos?" | \`gmail_list_awaiting_reply\` |
| "Send the intro template to alice@acme.com" / "Envíale la plantilla de presentación a alice@acme.com" | \`gmail_send_message\` (\`template_id\` + \`variables\`) |
| "Email Bob tomorrow at 9am about the renewal" / "Envíale un correo a Bob mañana a las 9 sobre la renovación" | \`gmail_send_message\` (\`send_at\`) |
| "Log that email thread to HubSpot" / "Registra ese hilo de correo en HubSpot" | \`gmail_log_to_hubspot\` |
| "Notify me in 30 minutes" / "Avísame en 30 minutos" | \`send_notification\` |
| "GET https://… and tell me the status" | \`http_request\` |
| "Show me my n8n workflows / flows" / "Muéstrame mis flujos de n8n" | \`n8n_list_workflows\` |
| "Turn on the invoice-sync flow" / "Activa el flujo de sincronización de facturas" | \`n8n_list_workflows\` to resolve the id, then \`n8n_activate_workflow\` |
| "Pause my daily-digest flow" / "Pausa mi flujo del resumen diario" | \`n8n_deactivate_workflow\` |
| "Run my report flow now" / "Ejecuta mi flujo de informes ahora" | \`n8n_run_workflow\` |
| "Why did my Slack-notify flow fail this morning?" / "¿Por qué falló mi flujo de avisos de Slack esta mañana?" | \`n8n_list_executions\` (\`status: error\`), then \`n8n_get_execution\` |
| "Delete the old lead-import flow" / "Elimina el flujo antiguo de importación de leads" | \`n8n_delete_workflow\` (confirm name + id first — permanent) |

**Calendar — resolving "my 3pm".** Reschedule/cancel/RSVP actions need an \`event_id\`. First call \`calendar_query_events\` with a window around the referenced time, pick the matching event's \`id\`, then call the mutation with that \`event_id\`. Datetimes are ISO 8601 in the user's local zone; resolve relative dates ("tomorrow", "Friday") against today's date.

**Gmail — answering questions about email.** Reads (\`gmail_search_messages\`, \`gmail_get_thread\`, \`gmail_get_contact_history\`, \`gmail_list_labels\`) are read-only and run immediately, no approval — use them freely to answer "did X reply?", "find the email about Y", "summarize my conversation with Z". Search accepts free text **or** Gmail operators (\`from:\`, \`to:\`, \`subject:\`, \`is:unread\`, \`has:attachment\`, \`after:YYYY/MM/DD\`, \`newer_than:7d\`) — prefer operators when the user names a sender or timeframe. A search returns \`thread_id\`s; read the full conversation with \`gmail_get_thread\` before summarizing or drafting a reply.

**Gmail — outreach (templates, send-later, follow-ups, CRM).** Templates live in the Email screen; \`gmail_send_message\` accepts \`template_id\` + \`variables\` (e.g. \`{"first_name":"Alice"}\`) — the send fails listing any unfilled \`{{tokens}}\`, so gather values first (from the user, or from HubSpot via \`hubspot_search_contact\` / \`hubspot_list_objects\` when personalizing outreach with CRM data). \`send_at\` (ISO 8601) schedules the send instead of sending now — Cerebro sends it at that time (or on next launch if the app was closed). \`gmail_list_awaiting_reply\` (read-only) lists sent emails with no reply after N days — combine a cron routine + this action + \`gmail_send_message\` with \`reply_to_thread_id\` for automatic follow-up nudges. \`gmail_log_to_hubspot\` copies a thread onto the matching HubSpot contact's timeline (needs the Private App to have the notes scope; relay the fix-it warning if it's missing).

**Gmail — sending.** \`gmail_send_message\` sends real email from the user's connected Gmail — it always pauses for approval; confirm recipients + subject + body with the user in chat first, then wait for the Approvals result before replying. To **reply inside an existing conversation**, pass \`reply_to_thread_id\` (from a prior search/read) — threading headers and the "Re:" subject are handled automatically; don't start a new thread when the user says "reply". When the user wants text prepared but *not* sent ("draft it", "prepara un borrador"), use \`gmail_create_draft\` — it saves into their Gmail Drafts. When drafting or replying, match the user's tone: pull their recent messages to that recipient with \`gmail_get_contact_history\` + \`gmail_get_thread\` and mirror how they actually write (greeting, formality, sign-off, language). Attachments: prefer \`file_item_id\`; \`file_path\` only for a file Cerebro just wrote (strip a leading \`@\` from \`@/abs/path\` annotations).

**HubSpot — attaching a contact to a ticket.** To link a ticket to someone, pass \`contact_email\` straight to \`hubspot_create_ticket\` — it looks the contact up by email and creates them if they don't exist, then associates the ticket, all in this one action. Do **not** call \`hubspot_upsert_contact\` first and try to thread the id across calls; \`run-chat-action\` runs one action at a time. Use \`hubspot_search_contact\` only when the user just wants to *check* whether a contact exists (it changes nothing). Already have the HubSpot contact id? Pass \`contact_id\` instead — it takes precedence.

**HubSpot — listing tickets.** When the user asks to *see* or *list* tickets ("list the tickets created today", "lista los tickets de hoy", "show open tickets"), use \`hubspot_search_tickets\` — it's read-only, so it runs immediately without approval. For "created today", pass \`created_after\` = the start of today and \`created_before\` = the start of tomorrow, as ISO dates in the user's local day (e.g. \`2026-05-28\` / \`2026-05-29\`). The result includes each ticket's \`stage_label\` and a \`ticket_url\` — use those in your reply rather than the raw ids. Note "ticket" is ambiguous in Spanish: see the \`list-tasks\` skill and the check-both rule in your main instructions before deciding whether the user means a HubSpot ticket or a Cerebro task.

**HubSpot — which company / contact is a ticket from.** When the user asks *who* or *which company* a ticket belongs to ("¿de qué empresa es el ticket 12345?", "who's the contact on this ticket?"), use \`hubspot_get_ticket\` with the \`ticket_id\`. It returns the ticket plus its associated \`contacts[]\` and \`companies[]\`. In HubSpot the company is usually **not** linked to the ticket directly — it comes from the ticket's associated *contact* — so each company carries \`source\` (\`"ticket"\` for a direct link, \`"contact"\` when derived through the contact) and \`via_contact_id\`. When \`source\` is \`"contact"\`, say so ("Acme — through the contact María"). To see the companies for *many* tickets at once (e.g. "how many of today's tickets are from Argos vs Keralty?"), pass \`include_associations: true\` to \`hubspot_search_tickets\` and group by company. If the result carries a non-null \`associations_error\`, the associations could **not** be read — relay that error instead of concluding the ticket has no contact or company.

**HubSpot — editing a ticket.** When the user asks to *change*, *edit*, *update*, or *move* an existing ticket ("change ticket 12345 priority to high", "cambia la prioridad del ticket 12345", "mueve el ticket a la etapa En espera", "update the subject", "reassign the ticket"), use \`hubspot_update_ticket\` with the \`ticket_id\` plus only the fields to change. Named fields cover the common cases — \`subject\`, \`content\`, \`priority\` (LOW/MEDIUM/HIGH), \`pipeline\`, \`stage\`, \`owner\` (assign by name/email — see below), \`follow_up_user\`, \`due_date\`, \`source_type\`; for any other (including **custom**) ticket property, pass a \`properties\` map of HubSpot internal name → value (it overrides the named fields on conflict). Only the fields you send are changed — everything else is left untouched. If you don't know the ticket id, find it first with \`hubspot_search_tickets\`; to confirm the current values (or the stage/pipeline ids) before editing, use \`hubspot_get_ticket\`. Like every HubSpot write this pauses for approval — confirm the change with the user first, then wait for the Approvals result before replying.

**HubSpot — owner, follow-up user, and due date.** To **assign** a ticket (on \`hubspot_create_ticket\` or \`hubspot_update_ticket\`), pass \`owner\` with the person's **name or email** — Cerebro resolves it to the HubSpot user id for you (you don't need the numeric owner id). Same for \`follow_up_user\` (the *usuario de seguimiento*). For the **due date** (*fecha de vencimiento*) pass \`due_date\` as an absolute \`YYYY-MM-DD\` (you know today's date — convert "mañana"/"next Friday" yourself). If a name is ambiguous the action returns a \`warnings\` entry listing the matching emails — re-run with the exact email. Follow-up user and due date are **custom** ticket properties: they only apply if the user mapped them in Settings → Integrations → HubSpot; if they aren't configured the ticket is still created/updated and a \`warning\` explains the field was skipped, so relay that to the user. Resolving names needs the \`crm.objects.owners.read\` scope on the Private App — if owners can't be read the \`warnings\` will say so.

**HubSpot — contacts, companies, deals (CRUD).** Beyond tickets, you can list/create/edit/delete the core CRM objects. Map the noun the user uses to \`object_type\`: people → \`contacts\`, *empresa(s)* / company → \`companies\`, *negocio(s)* / deal → \`deals\`. Use \`hubspot_list_objects\` to *see* records (read-only — runs immediately, no approval; filter by \`query\` or a typed field like \`email\`/\`domain\`/\`name\`/\`dealstage\`/\`pipeline\`; pass \`include_associations: true\` when the user asks what a record is linked to — "which company is this contact at?", "what deals / tickets does Acme have?" — it attaches each record's associated contacts, companies, deals, and tickets), \`hubspot_create_object\` to add, \`hubspot_update_object\` (needs \`object_id\`) to edit, and \`hubspot_delete_object\` (needs \`object_id\`) to remove. Pass the common fields as named params (\`name\`, \`domain\`, \`dealname\`, \`amount\`, …) and anything exotic via the \`properties\` map. **For contacts specifically, prefer \`hubspot_upsert_contact\`** — it dedups by email/phone, whereas \`hubspot_create_object\` with \`object_type: contacts\` just routes through the same upsert. If you don't have an id to edit/delete, find it first with \`hubspot_list_objects\`. \`hubspot_delete_object\` **archives** the record (recoverable in HubSpot) — it still pauses for approval like every write, so confirm with the user before invoking.

**HubSpot — lists / segments.** A "list" and a "segment" are the same thing. Use \`hubspot_list_lists\` to see them, \`hubspot_create_list\` to add one (defaults to a **static** list you can put records into; pass \`processing_type: DYNAMIC\` for a filter-based one), \`hubspot_update_list\` to rename, and \`hubspot_delete_list\` to archive it (the records on it are **not** deleted). To put someone *on* a list, use \`hubspot_list_membership\` with \`list_id\`, \`mode\` (\`add\`/\`remove\`) and \`record_ids\` — but you need the record's id first, so look the contact up with \`hubspot_list_objects\` or \`hubspot_search_contact\` and pass that id. **Only static lists accept manual membership** — dynamic lists are populated by HubSpot from their filters, so an add/remove there will come back as an error; tell the user the list is dynamic if that happens.

**HubSpot — when companies can't be read (missing scope).** If the action result has \`companies_scope_missing: true\` (or the summary notes companies weren't returned), the contacts came back fine but the HubSpot token lacks the \`crm.objects.companies.read\` permission. Don't just say "I can't" — tell the user exactly how to fix it, **step by step**, and reassure them the token does **not** change so they won't have to re-paste it. Walk them through it in their language, roughly:

1. In HubSpot, click the **⚙ Settings** gear (top right).
2. In the left menu, go to **Integrations → Private Apps**.
3. Open the private app you connected to Cerebro.
4. Go to the **Scopes** tab and click **Edit scopes** (or **Add new scopes**).
5. Search for **companies** and tick **\`crm.objects.companies.read\`**.
6. Click **Commit changes** (top right) to save.
7. That's it — the access token stays the same, so nothing to re-paste in Cerebro. Then ask the same question again and Cerebro will read the company.

Adjust the wording naturally and translate to Spanish when the user writes in Spanish ("haz clic en el engranaje ⚙ Configuración", "Integraciones → Aplicaciones privadas", "pestaña Permisos", "marca \`crm.objects.companies.read\`", "pulsa Confirmar cambios", "el token no cambia"). Keep it friendly and concrete, not a raw paste of this list.

**n8n — workflows ("flows").** n8n workflows live in the local n8n instance shown in the **Flows** screen. Users refer to them by *name* — resolve the name to an id with \`n8n_list_workflows\` (read-only, no approval) before any mutation. To **build or edit** a workflow ("create a flow that…", "add a step to my flow"), hand off to the \`n8n-flow-builder\` skill — do not hand-roll workflow JSON inside this skill. To debug a failure, chain \`n8n_list_executions\` (filter \`status: error\`, optionally \`workflow_id\`) with \`n8n_get_execution\` — it returns the failing node and error message; explain them in plain language. \`n8n_run_workflow\` executes immediately; if the flow only has a webhook trigger it must be **active** first. \`n8n_delete_workflow\` is **permanent** (no trash in n8n) — restate the exact workflow name and id and get explicit confirmation before invoking. Every result with an \`editor_url\` should be relayed as a link so the user can open the flow on the canvas.

**Slack — sending a file vs a message.** To send/share a **file** (an image, PDF, doc, the logo, …) on Slack, always use \`send_slack_file\` — it uploads the actual bytes so the recipient can open and download it. **Never** put a file path in a \`send_slack_message\` text body: that posts a useless local path like \`@/home/…/logo.png\`, not the file. Same rule for Telegram/WhatsApp media — use the dedicated media action, not a text message. When you reference a file, prefer \`file_item_id\` (a file Cerebro generated/registered); otherwise pass \`file_path\` as the **real absolute path** — and if the attachment shows up in context as \`@/abs/path\`, drop the leading \`@\` (the real path starts at the \`/\`).

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

5. **Tell the user the run is paused for approval.** The script blocks until the user clicks Approve or Deny in the **Approvals** tab. While you're waiting, do not start another action. (If the user previously set a "don't ask again" rule covering this action — its destination, its action type, or its integration — it runs immediately and you'll get \`SUCCESS\` straight away — no pause. See the \`manage-auto-approvals\` skill.)

## Interpreting the result

- \`SUCCESS:\` — the action ran. Restate the outcome in natural language using the printed JSON (\`ticket_id\`, \`message_id\`, \`status\`, etc.). Reply in the user's language.
- \`DENIED:\` — the user declined. Acknowledge briefly; do not retry without new instructions.
- \`NOT_CONNECTED:\` — the integration was disconnected between catalog fetch and run. Tell the user and link to Connections.
- \`ERROR:\` — surface the error message verbatim and offer next steps.

## What this skill does NOT do

- Turn off approval for *everything* at once. Every **write or send** runs through the human approval gate by default (read-only lookups never gate — they have no side effects). The only thing that lets a write skip the gate is a "don't ask again" rule the user sets explicitly via the \`manage-auto-approvals\` skill — scoped to one destination, one action type, or one integration. There is no global all-integrations "skip all approvals" switch; never imply one exists.
- Compose multi-step workflows. Use **Routines** for anything that should run more than once.
- Read or modify the file system, run code, or call experts — pick a different tool for that.
`,
    },
    {
      name: 'n8n-flow-builder',
      description:
        'Design and build n8n workflows ("flows") from natural language: author the workflow JSON, create it via n8n_create_workflow, hand the user an editor link, and iterate. Use when the user asks to build/automate something with n8n or the Flows screen. Spanish: "crea un flujo de n8n que…", "automatiza X con n8n", "hazme una automatización".',
      body: `# Build n8n flows

Use this skill when the user wants to **build, edit, or design an automation flow** in n8n — Cerebro's embedded workflow engine (the **Flows** screen). Trigger phrases (EN / ES):

- "build me an n8n flow that…", "create a workflow that…", "automate X with n8n"
- "crea un flujo de n8n que…", "hazme una automatización que…", "automatiza X con n8n"
- "add a step to my <name> flow", "añade un paso a mi flujo <name>"

If n8n isn't connected (\`n8n_*\` actions show \`not_connected\` in \`list-chat-actions\`), use the \`connect-integration\` skill with id \`n8n\` first.

## When to use n8n vs a Cerebro routine

- **Cerebro routine** — the steps use Cerebro's own actions (experts, memory, approvals, Telegram/Slack/HubSpot actions) and the user wants Cerebro supervision per run. Prefer routines when they fit.
- **n8n flow** — the automation needs services Cerebro has no actions for (Google Sheets, Gmail, Notion, arbitrary REST APIs with pagination…), needs a standalone webhook endpoint, or the user explicitly says n8n / Flows. n8n runs it autonomously once activated.

## Workflow JSON format

A workflow is one JSON document:

\`\`\`json
{
  "name": "Daily standup reminder",
  "nodes": [
    {
      "id": "unique-id-1",
      "name": "Schedule Trigger",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [0, 0],
      "parameters": { "rule": { "interval": [ { "field": "days", "triggerAtHour": 9 } ] } }
    },
    {
      "id": "unique-id-2",
      "name": "Send message",
      "type": "n8n-nodes-base.slack",
      "typeVersion": 2.2,
      "position": [220, 0],
      "parameters": { "resource": "message", "operation": "post", "select": "channel", "channelId": { "__rl": true, "mode": "name", "value": "#general" }, "text": "Standup in 15 minutes!" }
    }
  ],
  "connections": {
    "Schedule Trigger": { "main": [ [ { "node": "Send message", "type": "main", "index": 0 } ] ] }
  },
  "settings": { "executionOrder": "v1" }
}
\`\`\`

Rules that keep flows importable:

- **\`connections\` is keyed by the source node's \`name\`** (not id). Each value is \`{ "main": [ [ {node, type, index} ] ] }\` — an array of output slots, each an array of targets. Multi-output nodes (IF, Switch) use one inner array per output: \`"main": [ [ …true targets… ], [ …false targets… ] ]\`.
- Every node needs a unique \`id\`, a unique human \`name\`, \`type\`, \`typeVersion\`, \`position\` \`[x, y]\` (spread left→right ~220 px apart so the canvas reads well), and \`parameters\`.
- Exactly **one trigger node** per flow (webhook, schedule, or manual) unless the user asks otherwise.
- Workflows are created **inactive**. Activate (\`n8n_activate_workflow\`) only when the trigger should go live (schedules fire, webhooks listen).

## Node catalog (baseline for the pinned n8n; verified against the installed version)

| Node type | typeVersion | Minimal parameters |
| --- | --- | --- |
| \`n8n-nodes-base.manualTrigger\` | 1 | \`{}\` — run from the canvas Test button |
| \`n8n-nodes-base.scheduleTrigger\` | 1.2 | \`{"rule":{"interval":[{"field":"days","triggerAtHour":9}]}}\` (\`field\`: seconds/minutes/hours/days/weeks + \`triggerAtHour\`/\`triggerAtMinute\`/\`triggerAtDay\`) |
| \`n8n-nodes-base.webhook\` | 2 | \`{"path":"my-hook","httpMethod":"POST","responseMode":"onReceived"}\` — reachable at \`<instance>/webhook/<path>\` once active |
| \`n8n-nodes-base.httpRequest\` | 4.2 | \`{"url":"https://…","method":"GET"}\`; POST JSON: add \`"sendBody":true,"specifyBody":"json","jsonBody":"={{ JSON.stringify($json) }}"\` |
| \`n8n-nodes-base.if\` | 2.2 | \`{"conditions":{"options":{"caseSensitive":true,"typeValidation":"strict","version":2},"combinator":"and","conditions":[{"leftValue":"={{ $json.status }}","rightValue":"error","operator":{"type":"string","operation":"equals"}}]}}\` — output 0 = true, output 1 = false |
| \`n8n-nodes-base.switch\` | 3.2 | like IF but N outputs via \`rules.values\` |
| \`n8n-nodes-base.set\` | 3.4 | \`{"assignments":{"assignments":[{"id":"a1","name":"field","value":"={{ $json.x }}","type":"string"}]}}\` |
| \`n8n-nodes-base.code\` | 2 | \`{"mode":"runOnceForAllItems","jsCode":"return items;"}\` |
| \`n8n-nodes-base.merge\` | 3 | \`{"mode":"append"}\` |
| \`n8n-nodes-base.rssFeedRead\` | 1.1 | \`{"url":"https://…/feed.xml"}\` |
| \`n8n-nodes-base.emailSend\` | 2.1 | needs SMTP credential in n8n |
| \`n8n-nodes-base.slack\` | 2.2 | needs a Slack credential in n8n (separate from Cerebro's Slack) |
| \`n8n-nodes-base.telegram\` | 1.2 | \`{"chatId":"…","text":"…"}\`; needs a Telegram credential in n8n |
| \`n8n-nodes-base.gmail\` | 2.1 | needs a Google OAuth credential in n8n |
| \`n8n-nodes-base.googleSheets\` | 4.5 | needs a Google OAuth credential in n8n |
| \`n8n-nodes-base.respondToWebhook\` | 1.1 | pair with webhook \`"responseMode":"responseNode"\` |

Inside \`parameters\`, strings starting with \`=\` are n8n expressions: \`"={{ $json.email }}"\` reads the current item; \`$node["Node Name"].json.x\` reads another node's output.

**typeVersions drift across n8n releases.** The table above is the baseline for the version Cerebro installs. When editing an existing flow, ALWAYS fetch it first with \`n8n_get_workflow\` — the JSON you get back is the ground truth for parameter shapes and typeVersions; mirror what's there. If a create fails with a node error, read the message, fix that node, retry.

## Credentials inside n8n

Service nodes (Slack, Gmail, Sheets, Telegram…) authenticate with **n8n's own credentials**, configured inside the n8n editor — they are NOT Cerebro's integrations and you can never create or read them (the API forbids reading credential data; that's by design). Build the flow anyway with the nodes in place, then tell the user: open **Flows**, click the node showing a credential warning, and pick **Create new credential** — n8n walks them through it. Never ask for API keys in chat.

## The build loop

1. **Design first, in words.** Restate the flow as trigger + steps in one short list and confirm with the user if anything is ambiguous (which channel? what schedule? what should the message say?).
2. **Author the JSON** per the format above.
3. **Create it**: invoke \`n8n_create_workflow\` via \`run-chat-action\` (write action — it pauses for approval; tell the user to approve it in Approvals or inline).
4. **Hand over the canvas link.** The result carries \`editor_url\` — tell the user the flow is on the **Flows** screen canvas (it opens there automatically) and link the URL. If nodes need credentials, say which ones (step-by-step: click the node → create credential).
5. **Offer to activate** (\`n8n_activate_workflow\`) once the user is happy — required for schedule/webhook triggers to fire.
6. **Debug when asked** ("why did it fail?"): \`n8n_list_executions\` with \`status: error\` (+ \`workflow_id\`), then \`n8n_get_execution\` for the failing node + message. Fix by fetching the flow (\`n8n_get_workflow\`), editing the JSON, and \`n8n_update_workflow\` (send the FULL document back — updates replace, they don't patch).

## Use-case playbook (proven shapes to adapt)

1. **Lead & sales automation** — \`webhook\` (form/lead intake) → \`set\` (normalize fields) → \`httpRequest\` (enrich or CRM upsert) → \`slack\`/\`telegram\` (notify the rep).
2. **Support & ops triage** — \`gmail\`/\`webhook\` intake → \`code\` or AI classify → \`if\`/\`switch\` (route by category) → \`slack\` alert / CRM ticket via \`httpRequest\`.
3. **Content & marketing** — \`scheduleTrigger\` → \`rssFeedRead\` → \`if\` (fresh items) → AI summarize → post/draft via \`httpRequest\` or \`emailSend\`.
4. **Finance & documents** — \`webhook\` (invoice payload) → \`code\` (extract totals) → \`googleSheets\` append → weekly \`scheduleTrigger\` report → \`emailSend\`.
5. **Data sync** — \`scheduleTrigger\` → \`httpRequest\` (source page-by-page) → \`set\` (map fields) → \`httpRequest\` (destination upsert).
6. **Notifications & alerts** — \`scheduleTrigger\` (every N min) → \`httpRequest\` (check status/metric) → \`if\` (threshold) → \`slack\`/\`telegram\`.
7. **AI agent flows** — n8n's LangChain nodes (\`@n8n/n8n-nodes-langchain.*\`) use special non-\`main\` connection types (\`ai_languageModel\`, \`ai_tool\`, \`ai_memory\`) between the agent and its model/tools — they're finicky to author blind. Create the skeleton (trigger + agent node), then send the user to the canvas to wire the model there, or copy shapes from an existing AI flow via \`n8n_get_workflow\`.
8. **Scheduled jobs** — \`scheduleTrigger\` → whatever the job is → \`emailSend\`/\`slack\` digest.
9. **Webhook API glue** — \`webhook\` (\`responseMode: "responseNode"\`) → transform/fan out via \`httpRequest\` → \`respondToWebhook\` (n8n as instant middleware).

## What this skill does NOT do

- Configure credentials inside n8n (user does that on the canvas — see above).
- Delete flows silently. \`n8n_delete_workflow\` is permanent; confirm name + id explicitly first.
- Replace Cerebro routines — when the automation is really "Cerebro should do X on a schedule with approvals", propose a routine instead and say why.
`,
    },
    {
      name: 'manage-auto-approvals',
      description:
        'Record or revoke a "don\'t ask again" approval rule for any write/send. The scope adapts to the request: one destination (a Slack channel, Telegram chat, WhatsApp number), one action type (e.g. creating HubSpot tickets), or a whole integration (e.g. all of HubSpot). Use when the user says to stop (or resume) asking for approval. Spanish: "no me pidas aprobación para este chat", "ya no me pidas aprobar al crear tickets", "no me pidas aprobación para HubSpot", "vuelve a pedirme aprobación para #X".',
      body: `# Manage auto-approvals

By default **every** integration write/send pauses for human approval (read-only lookups never gate). A user can lift that by telling you so in chat. This skill records (or revokes) a standing "don't ask again" rule. Every rule is **persistent** (survives restart) and **revocable** here or in the Approvals tab. Whatever isn't covered by a rule still asks.

Use the **Bash** tool to run \`manage-auto-approvals.sh\`.

## Pick the scope from what the user asked

A rule is \`(action_type, target_key)\`. There are three scopes — **choose the narrowest one that matches the request**, and confirm the scope back to the user:

| Scope | What the user means | \`action_type\` | \`target_key\` |
| --- | --- | --- | --- |
| **Destination** | one channel / chat / recipient ("for #alerts", "para este chat") | the send action, e.g. \`send_slack_message\` | the destination id (channel id, \`chat_id\`, phone) |
| **Action type** | one kind of write anywhere ("before creating HubSpot tickets", "al crear tickets") | the action, e.g. \`hubspot_create_ticket\` | \`*\` |
| **Module** | a whole integration ("for HubSpot", "para HubSpot", "para Slack") | \`module:<group>\`, e.g. \`module:hubspot\` | \`*\` |

When in doubt between destination and action, lean on the user's wording: a named/implied destination → **destination**; a verb/object with no destination → **action**; the integration's name alone → **module**.

### Module tokens
\`module:hubspot\`, \`module:slack\`, \`module:telegram\`, \`module:whatsapp\`, \`module:github\`, \`module:calendar\`, \`module:http\`.

### Destination param per integration (for destination-scope rules)
- **Slack** (\`send_slack_message\`, \`send_slack_file\`) → channel id \`C…\`/\`G…\`/\`D…\`. If you only have a name like \`#general\`, run \`list_slack_channels\` via \`run-chat-action\` first to resolve the id.
- **Telegram** (\`send_telegram_message\` and the \`send_telegram_*\` media actions) → numeric \`chat_id\`.
- **WhatsApp** (\`send_whatsapp_message\` and \`send_whatsapp_*\` media actions) → \`phone_number\` (E.164 or JID).
- HubSpot / GitHub / calendar writes have **no** single destination — use **action-type** or **module** scope for those.

Reuse an id you already saw in the conversation when you can. Pass a human-readable label (e.g. \`#general\`, a contact name, or \`HubSpot\`) as the optional last arg so the Approvals UI reads nicely.

## When to use it (EN / ES)

| User says | Scope → do |
| --- | --- |
| "Don't ask again for #general" / "No me pidas aprobación otra vez para #general" | **destination** → add for that channel |
| "You can post to this Telegram chat without asking" / "Puedes escribir a este chat de Telegram sin preguntar" | **destination** → add for that \`chat_id\` |
| "Stop asking before I create HubSpot tickets" / "Ya no me pidas aprobación al crear tickets en HubSpot" | **action** → add \`hubspot_create_ticket\` \`*\` |
| "Don't ask for approval for HubSpot" / "No me pidas aprobación para HubSpot" | **module** → add \`module:hubspot\` \`*\` |
| "Ask me again before posting to #general" / "Vuelve a pedirme aprobación para #general" | **revoke** that rule |
| "What runs without approval?" / "¿Qué se ejecuta sin aprobación?" | **list** the rules |

## Add a rule

**Destination** — for a channel referred to generally ("don't ask again for #X"), add **both** Slack send actions so neither text nor files re-prompt:
\`\`\`bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/manage-auto-approvals.sh" add send_slack_message C0123456 "#general"
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/manage-auto-approvals.sh" add send_slack_file C0123456 "#general"
\`\`\`

**Action type** (any destination):
\`\`\`bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/manage-auto-approvals.sh" add hubspot_create_ticket "*" "HubSpot tickets"
\`\`\`

**Module** (whole integration):
\`\`\`bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/manage-auto-approvals.sh" add module:hubspot "*" "HubSpot"
\`\`\`

## Revoke a rule

Revoke with the **same** \`action_type\` and \`target_key\` you'd add:
\`\`\`bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/manage-auto-approvals.sh" revoke send_slack_message C0123456
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/manage-auto-approvals.sh" revoke module:hubspot "*"
\`\`\`

## List rules

\`\`\`bash
bash "$CLAUDE_PROJECT_DIR/.claude/scripts/manage-auto-approvals.sh" list
\`\`\`

## After running

- On \`SUCCESS\`, confirm plainly in the user's language and be explicit about scope — e.g. "Done — I won't ask for approval again before HubSpot actions. Other integrations still ask, and you can revoke this anytime from Approvals." / "Listo — ya no te pediré aprobación para las acciones de HubSpot. Las demás integraciones seguirán pidiéndola y puedes revocarlo cuando quieras desde Aprobaciones." Match the wording to the scope you set (this destination / this action / this whole integration).
- On \`ERROR\`, surface the message. \`not_auto_approvable:<type>\` means that key can't have a rule — usually a read-only action (those never pause anyway) or a typo'd action/module token. Never imply you can disable approvals for **everything** at once: there is no global all-integrations off switch.
`,
    },
    {
      name: 'propose-routine',
      description:
        'Draft a Cerebro Routine from a natural-language request, confirm it with the user, dry-run it end-to-end (with side-effects stubbed), then save it on success.',
      body: `# Propose routine

Use this skill whenever the user asks for **recurring or triggered work** — anything they want Cerebro to run more than once on a schedule, on an inbound message, or by clicking Run. Phrases that should match (English **or** Spanish):

- "every Monday morning…", "daily at 8…", "cada lunes…", "todos los días…"
- "when a Telegram message arrives from…", "cuando llegue un WhatsApp…", "when someone DMs Cerebro on Slack…", "cuando alguien mencione @Cerebro en #soporte…"
- "any time someone emails X, do Y", "set up a workflow that…"
- "make a routine that…", "crea una rutina que…"

For one-off work, use \`run-chat-action\` instead. For tracked tasks, use \`create-task\`.

## Workflow (always in this order)

### 1. Gather what you need

Find these in the conversation. If anything is missing, **ask one short clarifying question at a time** — don't dump a checklist.

- **name** — short title (3–8 words).
- **description** — one sentence about what the routine does.
- **trigger_type** — one of: \`manual\`, \`cron\`, \`webhook\`, \`telegram_message\`, \`slack_message\`, \`whatsapp_message\`, \`gmail_message\`, \`github_issue_opened\`, \`github_pr_review_requested\`. For \`gmail_message\` (fires when an email arrives in the connected Gmail inbox) the trigger config takes optional \`from\` (full address, \`@domain.com\` suffix, or \`*\` for anyone — default) and optional \`subject_contains\` (case-insensitive substring). Trigger payload exposes \`from\`, \`from_address\`, \`to\`, \`subject\`, \`snippet\`, \`thread_id\`, \`message_id\`, \`received_at\` as \`{{__trigger__.<field>}}\` — e.g. auto-reply routines pass \`{{trigger.thread_id}}\` into \`gmail_send_message\`'s \`reply_to_thread_id\`. For \`slack_message\` the trigger config takes \`channel\` (C…/G…/D…, or \`*\` for any allowlisted channel/DM), optional \`user_id\` (U…/W…), optional \`surface\` (\`app_mention\` | \`message_im\` | \`any\`), and optional \`filter_type\`/\`filter_value\` (keyword/prefix/regex). Trigger payload exposes \`channel\`, \`channel_type\`, \`user_id\`, \`user_name\`, \`thread_ts\`, \`ts\`, \`message_text\`, \`received_at\`, \`conversation_id\` as \`{{__trigger__.<field>}}\`. The two GitHub triggers fire only for repos the user added to the watched-repo allowlist (Settings → Integrations → GitHub). Trigger payload (available as \`{{__trigger__.<field>}}\`): \`repo_full_name\`, \`repo_owner\`, \`repo_name\`, \`title\`, \`body\`, \`author_login\`, \`html_url\`, plus \`issue_number\` (issues) or \`pr_number\` (PRs).
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

To see the full list of action types, action params, and which integrations are connected, run \`list-chat-actions\` first. Common action types include \`ask_ai\`, \`run_expert\`, \`classify\`, \`extract\`, \`summarize\`, \`search_memory\`, \`search_web\`, \`http_request\`, \`hubspot_create_ticket\`, \`hubspot_upsert_contact\`, \`hubspot_search_contact\`, \`hubspot_search_tickets\`, \`hubspot_get_ticket\`, \`hubspot_update_ticket\`, \`hubspot_list_objects\`, \`hubspot_create_object\`, \`hubspot_update_object\`, \`hubspot_delete_object\`, \`hubspot_list_lists\`, \`hubspot_create_list\`, \`hubspot_update_list\`, \`hubspot_delete_list\`, \`hubspot_list_membership\`, \`send_telegram_message\`, \`send_slack_message\`, \`send_slack_file\`, \`list_slack_channels\`, \`send_whatsapp_message\`, \`send_notification\`, \`github_create_issue\`, \`github_comment_issue\`, \`github_comment_pr\`, \`github_review_pr\`, \`github_open_pr\`, \`github_fetch_issue\`, \`github_fetch_pr\`, \`github_clone_worktree\`, \`github_commit_and_push\`, \`calendar_create_event\`, \`calendar_update_event\`, \`calendar_delete_event\`, \`calendar_rsvp\`, \`calendar_query_events\`, \`calendar_find_free_time\`, \`gmail_search_messages\`, \`gmail_get_thread\`, \`gmail_get_contact_history\`, \`gmail_list_labels\`, \`gmail_list_awaiting_reply\`, \`gmail_send_message\` (supports \`template_id\`+\`variables\` and \`send_at\` for send-later), \`gmail_create_draft\`, \`gmail_modify_labels\`, \`gmail_log_to_hubspot\`, \`n8n_list_workflows\`, \`n8n_get_workflow\`, \`n8n_create_workflow\`, \`n8n_update_workflow\`, \`n8n_activate_workflow\`, \`n8n_deactivate_workflow\`, \`n8n_run_workflow\`, \`n8n_list_executions\`, \`n8n_get_execution\`, \`condition\`, \`loop\`, \`delay\`. **Approval gates** (\`requiresApproval: true\` on a step, or a dedicated \`approval_gate\` step) are how a routine pauses for the user — recommend them for any external-facing send (Telegram, Slack, HubSpot, WhatsApp, and \`gmail_send_message\` — real email leaves the user's account), any calendar mutation (\`calendar_create_event\`, \`calendar_update_event\`, \`calendar_delete_event\`, \`calendar_rsvp\`), for any GitHub mutation (\`github_create_issue\`, \`github_comment_*\`, \`github_review_pr\`, \`github_open_pr\`, \`github_commit_and_push\`), and for any n8n mutation (\`n8n_create_workflow\`, \`n8n_update_workflow\`, \`n8n_activate_workflow\`, \`n8n_deactivate_workflow\`, \`n8n_run_workflow\`, \`n8n_delete_workflow\`). A typical n8n routine step: \`n8n_run_workflow\` on a cron trigger to kick a flow, or \`n8n_list_executions\` + \`condition\` to alert when a flow fails.

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
- **For external-facing actions** (Telegram, Slack, WhatsApp, HubSpot, email, run_command), **add an \`approval_gate\` step or set \`requiresApproval: true\`** on the action step so real runs pause for the user.
- Reply in the user's language (English or Spanish) throughout.
`,
    },
    {
      name: 'connect-integration',
      description:
        'Open the inline setup card so the user can connect an integration (Telegram, Slack, HubSpot, WhatsApp, GoHighLevel, …) without leaving the chat. Never ask for tokens in chat — the card collects them securely.',
      body: `# Connect an integration

Use this skill whenever the user asks Cerebro to **connect, set up, link, or wire up** an external service — anything that needs credentials before \`run-chat-action\` or a routine can use it. Phrases that should match (English **or** Spanish):

- "set up Telegram", "connect Telegram", "help me set up the Telegram bot"
- "set up Slack", "connect Slack", "conecta Slack", "configura Slack"
- "configura HubSpot", "conecta WhatsApp", "vincula mi cuenta de HubSpot"
- "I want to use Telegram with Cerebro", "how do I connect HubSpot"
- "connect GoHighLevel", "set up GHL", "conecta GoHighLevel", "vincula mi CRM de GHL"
- "set up n8n", "install n8n", "instala n8n", "configura n8n", "quiero usar n8n"
- "connect Gmail", "set up my email", "conecta Gmail", "configura mi correo"
- "connect my calendar", "conecta mi calendario", "set up Google Calendar / Outlook"

Currently supported \`integration_id\` values: \`telegram\`, \`slack\`, \`hubspot\`, \`whatsapp\`, \`ghl\`, \`github\`, \`calendar\`, \`n8n\`, \`gmail\`. Others — including everything listed as "coming soon" in the Integrations screen — are not yet implemented; tell the user it's on the roadmap and stop.

## Workflow

1. **Confirm intent and pick the integration_id.** Match the user's wording to one of \`telegram\`, \`slack\`, \`hubspot\`, \`whatsapp\`, \`ghl\`, \`github\`, \`calendar\`, \`n8n\`, \`gmail\`. "GoHighLevel" / "GHL" / "Lead Connector" all map to \`ghl\`. "GitHub" / "gh" / "git" (when context makes it clear they mean github.com) maps to \`github\`. "n8n" / "workflow automation" / "flows engine" maps to \`n8n\`. "Gmail" / "email" / "correo" / "mail" maps to \`gmail\`; "calendar" / "calendario" / "Google Calendar" / "Outlook" maps to \`calendar\`. If the user is ambiguous (e.g. "set up CRM"), ask one short clarifying question (HubSpot or GoHighLevel?).
2. **Open the setup card.** Run:

   \`\`\`bash
   bash "$CLAUDE_PROJECT_DIR/.claude/scripts/propose-integration.sh" INTEGRATION_ID "WHY_THIS_INTEGRATION"
   \`\`\`

   Replace \`INTEGRATION_ID\` with one of \`telegram\` / \`slack\` / \`hubspot\` / \`whatsapp\` / \`ghl\` / \`github\` / \`calendar\` / \`n8n\` / \`gmail\`. The reason argument is optional and shown as the card subtitle ("So your team can talk to Cerebro in Slack", "So you can send WhatsApp from routines", "So Cerebro can drive your GitHub repos").

3. **Tell the user the card is ready.** One short line in their language: "I'll help you connect Telegram. Open the setup card below." Don't dump instructions — the card already shows the BotFather/Private App walkthrough.

4. **Answer follow-up questions conversationally.** While the card is open, the user may ask things like "what's BotFather?", "where do I find scopes in HubSpot?", "do I need WhatsApp Business?". Use this prose as your source of truth so you don't make things up:

   ### Telegram (BotFather)
   - Open Telegram and start a chat with **@BotFather** (the @ matters — confirm exactly that handle).
   - Send \`/newbot\` and follow the prompts to name your bot and pick a unique username (must end in \`bot\`).
   - BotFather replies with a token like \`123456789:AABBccDD…\`. Copy it.
   - Paste the token in the card's step 2. Cerebro verifies it against Telegram's getMe API and stores it encrypted in the OS keychain.

   ### Slack (App manifest + Socket Mode)
   - Cerebro runs in Socket Mode (no public URL needed), so the customer creates their own Slack app from the manifest YAML Cerebro ships.
   - In the inline card, click **Copy manifest** to copy the YAML, then click **Open Slack App builder** which takes them to \`api.slack.com/apps?new_app=1&manifest_yaml=…\` with the manifest pre-filled. They pick their workspace and click **Create**.
   - Once the app exists, they open **Install App** in the sidebar and click **Install to Workspace** — Slack asks them to approve the requested scopes. After approval, they copy the **Bot User OAuth Token** (\`xoxb-…\`).
   - Next, on **Basic Information → App-Level Tokens**, they click **Generate Token and Scopes**, name it (e.g. \`socket\`), add the **\`connections:write\`** scope, click **Generate**, and copy the \`xapp-…\` token.
   - They paste both tokens into the card. Cerebro calls \`auth.test\` with the bot token and opens a quick Socket Mode handshake with the app token to verify everything works. Both tokens are stored encrypted in the OS keychain.
   - After install: users DM the bot, mention \`@Cerebro\` in any channel (it replies in-thread visible to the channel), or use \`/cerebro help\` for the menu. Each Slack thread becomes its own Cerebro conversation.
   - The Slack card has an **allowlist** for channels and users. Closed-by-default — empty allowlists mean the bridge ignores everyone. Tell the operator to add the Slack IDs (or \`*\`) of who can talk to Cerebro.

   ### HubSpot (Private App access token)
   - In HubSpot, open **Settings → Integrations → Private Apps** (also reachable via the Legacy Apps shortcut).
   - Click **Create a private app**, name it (e.g. "Cerebro"), and click **Scopes**.
   - Enable **tickets** and **pipelines**, plus **read + write** on **contacts**, **companies**, **deals**, and **lists** (the \`crm.objects.*\` and \`crm.lists.*\` CRM scopes) so Cerebro can manage your CRM records and segments.
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

   ### Gmail (bring-your-own Google OAuth client)
   - Cerebro connects with the **user's own** Google Cloud OAuth client, so their mail never touches third-party servers and no app-verification is needed. It's a one-time ~5-minute Google Cloud setup.
   - In [Google Cloud Console](https://console.cloud.google.com), create (or reuse) a project, then enable the **Gmail API** under **APIs & Services → Library**.
   - Under **APIs & Services → Credentials**, create an **OAuth client ID** of type **Desktop app**. Desktop clients allow the \`http://127.0.0.1\` loopback redirect automatically — no redirect URI to configure.
   - On the **OAuth consent screen**, add themselves as a user and **publish the app to Production** (leaving it in "Testing" makes Google expire the sign-in every 7 days). Google will show an "unverified app" warning during authorization — that's expected for a personal app; click **Advanced → Continue**.
   - Paste the **Client ID** and **Client Secret** into the card, then click **Authorize** — the browser opens for Google sign-in and consent. Tokens are encrypted in the OS keychain, device-local only.
   - After connecting, Cerebro syncs recent mail locally (search stays instant and private), the **Email** screen lights up, and chat + routines can search, read, draft, and send email (sends always pause for approval).

   ### Calendar (bring-your-own OAuth client — Google or Outlook)
   - Same model as Gmail: the user creates their own OAuth app (Google Cloud Console or Azure portal), pastes Client ID + Secret in the card, and authorizes in the browser.
   - For Google they enable the **Google Calendar API**; for Outlook they register an app in **Azure → App registrations** with the Calendars.ReadWrite delegated permission.
   - Multiple accounts can be connected; tokens are encrypted device-local.

   ### n8n (managed local install — no credentials)
   - n8n is the one integration where the card asks for **nothing**: Cerebro downloads n8n from npm onto this machine, runs it locally, and provisions its account + API key automatically. No token to paste, no sign-up, and workflow data never leaves the machine.
   - The install downloads a few hundred MB on first setup and needs **Node.js 22+** installed. If the card reports "Node.js required", point the user to https://nodejs.org, then retry.
   - Workflows can run custom code (that's what n8n is for) — same trust model as running n8n anywhere else.
   - When it finishes, the **Flows** screen in the sidebar shows the full n8n editor, and chat can build flows via the \`n8n-flow-builder\` skill.

5. **Don't ask for credentials in chat.** The card's input fields collect tokens directly through the secure IPC bridge so secrets never reach the LLM context. If the user pastes a token in chat by mistake, ignore it and remind them to enter it in the card.

## Interpreting the script output

- \`SUCCESS:\` — card opened. Tell the user.
- \`ERROR:\` — surface the message verbatim. Common causes: unknown \`integration_id\`, chat-actions server not running, main window not ready.

## What this skill does NOT do

- Walk the user through setup in plain text. The card owns the walkthrough.
- Collect, store, or even read credentials. The card does that.
- Connect integrations not in the registry yet. If the user asks for Notion or anything else still marked "coming soon", say it's on the roadmap and stop.
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

async function fetchExpertSkills(backendPort: number, expertId: string): Promise<SkillData[]> {
  const result = await fetchJson<{
    skills: Array<{ skill: SkillData; is_active: boolean }>;
  }>(backendPort, `/experts/${expertId}/skills`);
  return (result?.skills ?? []).filter((s) => s.is_active).map((s) => s.skill);
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
  // The builtin Cerebro expert is skipped: it maps to the canonical `cerebro`
  // agent (written by installCerebroMainAgent), so materializing a persona file
  // for it would create a competing duplicate.
  const regulars = experts.filter(
    (e) => (e.type ?? 'expert') !== 'team' && e.id !== CEREBRO_EXPERT_ID,
  );
  const teams = experts.filter((e) => e.type === 'team');

  // Fetch skills + context files for each regular expert (teams don't carry either).
  const [regularSkillSets, regularContextSets] = await Promise.all([
    Promise.all(regulars.map((expert) => fetchExpertSkills(options.backendPort, expert.id))),
    Promise.all(regulars.map((expert) => fetchExpertContextFiles(options.backendPort, expert.id))),
  ]);

  const agentNameById: Record<string, string> = {};
  const memberNamesById: Record<string, string> = {};

  for (let i = 0; i < regulars.length; i++) {
    const expert = regulars[i];
    const agentName = expertAgentName(expert.id, expert.name);
    seen.add(agentName);
    writeExpertAgent(paths, expert, agentName, regularSkillSets[i], regularContextSets[i]);
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
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
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
      try {
        fs.unlinkSync(path.join(paths.agentsDir, file));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* directory missing — ignore */
  }

  writeIndex(paths.indexPath, index);
}

/** Install or update a single expert (for CRUD sync). */
export async function installExpert(options: InstallerOptions, expert: ExpertData): Promise<void> {
  // The builtin Cerebro expert maps to the canonical `cerebro` agent and is
  // never materialized as a persona file (see installAll).
  if (expert.id === CEREBRO_EXPERT_ID) return;
  const paths = resolvePaths(options.dataDir);
  fs.mkdirSync(paths.agentsDir, { recursive: true });
  fs.mkdirSync(paths.memoryRoot, { recursive: true });

  const index = readIndex(paths.indexPath);
  const previousName = index.experts[expert.id];
  const agentName = expertAgentName(expert.id, expert.name);

  // If name changed, remove the stale file.
  if (previousName && previousName !== agentName) {
    try {
      fs.unlinkSync(path.join(paths.agentsDir, `${previousName}.md`));
    } catch {
      /* ignore */
    }
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
  scope: string; // "personal", "expert", etc.
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
  const result = await fetchJson<{ key: string; value: string }>(
    backendPort,
    '/settings/beta:teams',
  );
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
  fs.writeFileSync(path.join(paths.agentsDir, `${agentName}.md`), renderAgentFile(file), 'utf-8');
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
  fs.writeFileSync(path.join(paths.agentsDir, `${agentName}.md`), renderAgentFile(file), 'utf-8');
  seedFileIfMissing(path.join(memoryDir, 'SOUL.md'), buildSoulFile(expert));
}

function installSkill(paths: InstallerPaths, skill: SkillSpec): void {
  const dir = path.join(paths.skillsDir, skill.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillFile(skill), 'utf-8');
}
