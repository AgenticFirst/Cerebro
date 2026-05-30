/**
 * Codex prompt compilation.
 *
 * Codex has no named subagents and no skills auto-discovery, so (following
 * obelisk's `compileCodex`) Cerebro inlines the system prompt + skills into the
 * stdin prompt on the FIRST turn of a session. On resume, codex reloads its own
 * session transcript, so we send only the user's new message.
 *
 * Rather than duplicate the installer's prompt-building logic, we REUSE the
 * agent + skill markdown that `installAll` already materializes under
 * `<dataDir>/.claude/`:
 *   - `.claude/agents/<agentName>.md`  → the system block (frontmatter stripped)
 *   - `.claude/skills/<name>/SKILL.md` → inlined skills catalog
 * The Codex runner sets `CLAUDE_PROJECT_DIR=<dataDir>` so the
 * `$CLAUDE_PROJECT_DIR/.claude/scripts/*.sh` references inside those bodies
 * resolve identically for both engines (chat-actions / approvals work unchanged).
 *
 * Reading these files is synchronous and cheap (a handful of small markdown
 * files) — fine to do per first-turn.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CompilePromptArgs } from '../types';
import { getCodexCwd } from './config';

/**
 * Codex can't delegate to subagents (no Agent tool), so neutralize the
 * delegation guidance the reused Cerebro body assumes.
 */
const CODEX_ENGINE_NOTE = `## Engine note (Codex)

You are running on the **Codex** engine. Unlike the Claude engine, you do NOT have an \`Agent\` tool and cannot delegate to expert sub-agents. Ignore any instruction above about invoking experts/teams via the \`Agent\` tool. Handle the user's request directly with your own tools (shell, file edits, web). All Cerebro skill scripts under \`$CLAUDE_PROJECT_DIR/.claude/scripts/\` ARE available to you via your shell — use them exactly as described. If a request genuinely requires expert delegation, do your best directly and let the user know they can switch Cerebro's engine to Claude for full expert/team delegation.`;

export function buildCodexPrompt(args: CompilePromptArgs): string {
  if (!args.isFirstTurn) return args.userTurn;
  const prefix = buildSystemPrefix(args.agentName);
  return prefix ? `${prefix}\n\n---\n\n${args.userTurn}` : args.userTurn;
}

function buildSystemPrefix(agentName: string): string {
  const cwd = getCodexCwd();
  if (!cwd) return '';
  const claudeDir = path.join(cwd, '.claude');

  const systemBlock = readAgentBody(path.join(claudeDir, 'agents', `${agentName}.md`));
  if (!systemBlock) return '';

  const blocks = [systemBlock, CODEX_ENGINE_NOTE];

  // The main Cerebro agent enumerates its skills in prose but relies on Claude
  // auto-discovering the SKILL.md detail. Inline that detail for Codex. Experts
  // bake their own skills into their body, so only do this for the main agent.
  if (agentName === 'cerebro') {
    const skills = readSkillsCatalog(path.join(claudeDir, 'skills'));
    if (skills) blocks.push(skills);
  }

  return blocks.join('\n\n---\n\n');
}

/** Read an agent markdown file and strip its YAML frontmatter. */
function readAgentBody(filePath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  return stripFrontmatter(raw).trim() || null;
}

/** Inline every SKILL.md under the skills dir as a `### Skill: <name>` section. */
function readSkillsCatalog(skillsDir: string): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    return '';
  }
  const sections: string[] = [];
  for (const name of entries.sort()) {
    const skillFile = path.join(skillsDir, name, 'SKILL.md');
    let raw: string;
    try {
      raw = fs.readFileSync(skillFile, 'utf-8');
    } catch {
      continue;
    }
    const body = stripFrontmatter(raw).trim();
    if (body) sections.push(`### Skill: ${name}\n\n${body}`);
  }
  if (sections.length === 0) return '';
  return ['## Skill instructions (inlined for Codex)', '', ...sections].join('\n\n');
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  // Find the closing '---' of the leading frontmatter block.
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return raw;
  const after = raw.indexOf('\n', end + 1);
  return after === -1 ? '' : raw.slice(after + 1);
}
