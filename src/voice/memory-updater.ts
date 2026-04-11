/**
 * VoiceMemoryUpdater — fire-and-forget end-of-call memory update.
 *
 * When a voice call ends, this spawns a detached Claude Code subprocess that
 * reads the expert's existing agent-memory files, processes the call
 * transcript, and writes durable facts back to the memory directory. Runs in
 * parallel with the UI returning the user to the Experts screen; survives
 * Electron quit via `detached: true` + `unref()`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getCachedClaudeCodeInfo } from '../claude-code/detector';
import { expertAgentName } from '../claude-code/installer';
import { wrapClaudeSpawn } from '../sandbox/wrap-spawn';

export interface VoiceMemoryUpdateParams {
  dataDir: string;
  expertId: string;
  expertName: string;
  expertDomain: string | null;
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
}

const MODEL = 'claude-haiku-4-5';

export function fireVoiceMemoryUpdate(params: VoiceMemoryUpdateParams): void {
  const info = getCachedClaudeCodeInfo();
  if (info.status !== 'available' || !info.path) {
    console.warn('[VoiceMemory] Claude Code unavailable — skipping memory update');
    return;
  }

  const agentName = expertAgentName(params.expertId, params.expertName);
  const memoryDir = path.join(params.dataDir, 'agent-memory', agentName);

  try {
    fs.mkdirSync(memoryDir, { recursive: true });
  } catch (err) {
    console.error('[VoiceMemory] failed to create memory dir:', err);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildStewardPrompt({
    expertName: params.expertName,
    expertDomain: params.expertDomain,
    memoryDir,
    today,
  });
  const promptBody = formatTranscript(params.transcript);

  const args = [
    '-p', promptBody,
    '--output-format', 'text',
    '--max-turns', '5',
    '--model', MODEL,
    '--dangerously-skip-permissions',
    '--system-prompt', systemPrompt,
    '--allowedTools', 'Read,Write,Edit,Glob',
  ];

  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;

  const wrapped = wrapClaudeSpawn({ claudeBinary: info.path, claudeArgs: args });

  const t0 = Date.now();
  const child = spawn(wrapped.binary, wrapped.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: memoryDir,
    env,
    detached: true,
  });
  child.unref();

  let stderrTail = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-500);
  });
  child.on('close', (code) => {
    const ms = Date.now() - t0;
    const turns = params.transcript.length;
    if (code === 0) {
      console.log(`[VoiceMemory] ${agentName} updated in ${ms}ms (${turns} turns)`);
    } else {
      console.error(
        `[VoiceMemory] ${agentName} exited code=${code} ms=${ms} stderr=${stderrTail.trim().slice(-200)}`,
      );
    }
  });
  child.on('error', (err) => console.error('[VoiceMemory] spawn error:', err.message));
}

function formatTranscript(
  history: Array<{ role: string; content: string }>,
): string {
  const body = history
    .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
    .join('\n');
  return `<transcript>\n${body}\n</transcript>\n\nProcess this transcript per your instructions.`;
}

function buildStewardPrompt(opts: {
  expertName: string;
  expertDomain: string | null;
  memoryDir: string;
  today: string;
}): string {
  const domainClause = opts.expertDomain ? ` (domain: ${opts.expertDomain})` : '';
  return `You are the memory steward for **${opts.expertName}**, a Cerebro specialist expert${domainClause}. A voice call between the user and ${opts.expertName} just ended. Your job is to update the expert's long-term memory based on what was said.

The expert's memory directory is:
  ${opts.memoryDir}

Procedure:
1. Glob \`*.md\` in that directory. Read every file that exists. If none exist, the directory is new.
2. Read the transcript below. Extract ONLY durable information:
   - Facts about the user (preferences, goals, constraints, relationships, context)
   - Commitments made (by either party)
   - Decisions reached
   - Style/tone feedback the user gave the expert
   Ignore: small talk, transient state, questions the expert answered without new input from the user.
3. Update memory. Conventions:
   - \`SOUL.md\` — persona, working style. Only edit if the user gave explicit feedback about how the expert should behave.
   - \`facts.md\` — bullet list of durable facts about the user. Merge new facts, dedupe, keep compact.
   - \`history.md\` — dated log of sessions. Append one short paragraph for this call (date, topics, outcomes). Today is ${opts.today}.
   - Topic-specific files (e.g. \`training-plan.md\`, \`preferences.md\`) — create or update when a cluster of facts warrants a dedicated file.
   Use \`Write\` for new files, \`Edit\` for existing. Keep each file small and topical.
4. If the transcript contains nothing worth persisting, exit silently without writing anything. Do NOT write "nothing to save" files.

Constraints:
- Never store secrets, API keys, passwords, or anything sensitive.
- Do not invent facts. Only record what the transcript actually contains.
- Prefer editing existing files over creating new ones.
- Write facts in third person ("the user ..."), SOUL entries in first person ("I ...").`;
}
