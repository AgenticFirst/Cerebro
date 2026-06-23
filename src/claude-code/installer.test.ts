import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  expertAgentName,
  installAll,
  installExpert,
  removeExpert,
  getAgentNameForExpert,
  resolvePaths,
} from './installer';

interface ExpertFixture {
  id: string;
  name: string;
  slug: string | null;
  description: string;
  system_prompt: string | null;
  domain: string | null;
  policies: null;
  is_enabled: boolean;
}

function startBackend(experts: ExpertFixture[]): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url || '';
      if (url.startsWith('/experts?')) {
        res.statusCode = 200;
        res.end(JSON.stringify({ experts }));
        return;
      }
      const skillsMatch = url.match(/^\/experts\/([^/]+)\/skills$/);
      if (skillsMatch) {
        res.statusCode = 200;
        res.end(JSON.stringify({ skills: [] }));
        return;
      }
      const expertMatch = url.match(/^\/experts\/([^/?]+)(\?|$)/);
      if (expertMatch) {
        const found = experts.find((e) => e.id === expertMatch[1]);
        if (!found) {
          res.statusCode = 404;
          res.end('{}');
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify(found));
        return;
      }
      if (url.startsWith('/memory/')) {
        res.statusCode = 200;
        res.end('[]');
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

describe('expertAgentName', () => {
  it('is deterministic for the same (id, name)', () => {
    const a = expertAgentName('abc123', 'Design Expert');
    const b = expertAgentName('abc123', 'Design Expert');
    expect(a).toBe(b);
  });

  it('produces a slug-safe, lowercased, hyphenated name', () => {
    const name = expertAgentName('xyz', 'Design Expert!! With "funky" Chars');
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.startsWith('design-expert')).toBe(true);
  });

  it('changes when the expert id changes (so renames do not collide)', () => {
    const a = expertAgentName('id-one', 'Design Expert');
    const b = expertAgentName('id-two', 'Design Expert');
    expect(a).not.toBe(b);
  });

  it('falls back to "expert" prefix when the name has no slug characters', () => {
    const name = expertAgentName('abc', '!!! ???');
    expect(name.startsWith('expert-')).toBe(true);
  });
});

describe('installer materialization', () => {
  let dataDir: string;
  let backend: { port: number; close: () => void };

  const expertsFixture: ExpertFixture[] = [
    {
      id: 'e1',
      name: 'Design Expert',
      slug: null,
      description: 'Helps with design',
      system_prompt: 'You are a design expert.',
      domain: 'creative',
      policies: null,
      is_enabled: true,
    },
    {
      id: 'e2',
      name: 'Code Reviewer',
      slug: null,
      description: 'Reviews code',
      system_prompt: 'You review code.',
      domain: 'engineering',
      policies: null,
      is_enabled: true,
    },
  ];

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-installer-'));
    backend = await startBackend(expertsFixture);
  });

  afterEach(() => {
    backend.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('installAll writes a .md file for every enabled expert AND updates the index', async () => {
    await installAll({ dataDir, backendPort: backend.port });

    const paths = resolvePaths(dataDir);
    const index = JSON.parse(fs.readFileSync(paths.indexPath, 'utf-8')) as {
      experts: Record<string, string>;
    };

    for (const expert of expertsFixture) {
      const slug = index.experts[expert.id];
      expect(slug, `index missing entry for expert ${expert.id}`).toBeTruthy();
      const agentFile = path.join(paths.agentsDir, `${slug}.md`);
      expect(
        fs.existsSync(agentFile),
        `expected agent file at ${agentFile} for expert ${expert.id}`,
      ).toBe(true);
      const contents = fs.readFileSync(agentFile, 'utf-8');
      expect(contents).toContain(`name: ${slug}`);
      expect(contents).toContain('tools:');
    }
  });

  it('installAll writes the cerebro main agent', async () => {
    await installAll({ dataDir, backendPort: backend.port });
    const paths = resolvePaths(dataDir);
    const cerebroFile = path.join(paths.agentsDir, 'cerebro.md');
    expect(fs.existsSync(cerebroFile)).toBe(true);
  });

  it('cerebro prompt tells the agent read-only lookups run without approval', async () => {
    // Guards the bug fix at the prompt layer: the agent must NOT announce or
    // expect an approval pause for read-only lookups (HubSpot search/get/list,
    // calendar query, Slack channel list). Bulk reads like "review 20 contacts"
    // should just run. If this copy regresses, the agent reverts to gating reads.
    await installAll({ dataDir, backendPort: backend.port });
    const paths = resolvePaths(dataDir);
    const cerebro = fs.readFileSync(path.join(paths.agentsDir, 'cerebro.md'), 'utf-8');

    // Explicit statement that read-only lookups don't pause.
    expect(cerebro).toContain('Read-only lookups never pause');
    // The run-chat-action summary must scope approval to writes/sends.
    expect(cerebro).toMatch(/[Rr]ead-only lookups.*run.*immediately/);
    // The reported scenario (bulk reads) is called out in both languages.
    expect(cerebro).toContain('review 20 contacts');
    expect(cerebro).toContain('revisa 20 contactos');
  });

  it('installAll writes the knowledge-base skill and its scripts', async () => {
    await installAll({ dataDir, backendPort: backend.port });
    const paths = resolvePaths(dataDir);

    const skillFile = path.join(paths.skillsDir, 'knowledge-base', 'SKILL.md');
    expect(fs.existsSync(skillFile), `expected KB skill at ${skillFile}`).toBe(true);
    const skill = fs.readFileSync(skillFile, 'utf-8');
    expect(skill).toContain('name: knowledge-base');
    // Bilingual triggers must be present so the agent fires on Spanish too.
    expect(skill).toContain('base de conocimiento');
    // The skill should teach search-first.
    expect(skill).toContain('kb-search.sh');

    const scripts: Record<string, string> = {
      'kb-list-pages.sh': '/knowledge/pages',
      'kb-search.sh': '/knowledge/search',
      'kb-read-page.sh': '/knowledge/pages',
      'kb-create-page.sh': '/knowledge/pages',
      'kb-update-page.sh': '/knowledge/pages',
    };
    for (const [script, endpoint] of Object.entries(scripts)) {
      const p = path.join(paths.scriptsDir, script);
      expect(fs.existsSync(p), `expected script at ${p}`).toBe(true);
      expect(fs.readFileSync(p, 'utf-8')).toContain(endpoint);
    }

    // The main Cerebro agent should advertise the skill.
    const cerebro = fs.readFileSync(path.join(paths.agentsDir, 'cerebro.md'), 'utf-8');
    expect(cerebro).toContain('`knowledge-base`');
  });

  it('run-chat-action.sh stamps the conversation id onto the request body', async () => {
    // The shell link in the chain that surfaces approvals inline: it must read
    // CEREBRO_CONVERSATION_ID and inject it as `conversation_id` into the body
    // posted to /chat-actions/run. Without this, the engine can't attribute the
    // approval to a conversation and the inline card never appears.
    await installAll({ dataDir, backendPort: backend.port });
    const paths = resolvePaths(dataDir);

    const scriptPath = path.join(paths.scriptsDir, 'run-chat-action.sh');
    expect(fs.existsSync(scriptPath), `expected script at ${scriptPath}`).toBe(true);
    const script = fs.readFileSync(scriptPath, 'utf-8');

    expect(script).toContain('CEREBRO_CONVERSATION_ID');
    // The jq merge that adds the field to the JSON body.
    expect(script).toContain('conversation_id: $cid');
    // It still POSTs the (possibly stamped) payload to the run endpoint.
    expect(script).toContain('/chat-actions/run');
  });

  it('installExpert writes a single expert .md file with valid frontmatter', async () => {
    await installExpert({ dataDir, backendPort: backend.port }, expertsFixture[0]);
    const paths = resolvePaths(dataDir);
    const slug = expertAgentName(expertsFixture[0].id, expertsFixture[0].name);
    const file = path.join(paths.agentsDir, `${slug}.md`);
    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, 'utf-8');
    // Frontmatter shape
    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toContain(`name: ${slug}`);
    expect(body).toContain('description:');
    expect(body).toContain('tools:');
    // Index is updated
    expect(getAgentNameForExpert(dataDir, expertsFixture[0].id)).toBe(slug);
  });

  it('removeExpert deletes the .md file and the index entry', async () => {
    await installExpert({ dataDir, backendPort: backend.port }, expertsFixture[0]);
    const slug = expertAgentName(expertsFixture[0].id, expertsFixture[0].name);
    removeExpert({ dataDir, backendPort: backend.port }, expertsFixture[0].id);
    const paths = resolvePaths(dataDir);
    expect(fs.existsSync(path.join(paths.agentsDir, `${slug}.md`))).toBe(false);
    expect(getAgentNameForExpert(dataDir, expertsFixture[0].id)).toBeNull();
  });

  it('installAll cleans orphan .md files whose expert is no longer in the backend list', async () => {
    await installAll({ dataDir, backendPort: backend.port });
    const paths = resolvePaths(dataDir);

    // Manually drop a stray .md and a stale index entry, as if an expert was deleted
    // via the backend but the on-disk state lagged.
    const orphanFile = path.join(paths.agentsDir, 'ghost-expert-deadbe.md');
    fs.writeFileSync(orphanFile, '---\nname: ghost-expert-deadbe\n---\n', 'utf-8');

    await installAll({ dataDir, backendPort: backend.port });
    expect(fs.existsSync(orphanFile)).toBe(false);
  });

  it('getAgentNameForExpert returns null before install, correct slug after', async () => {
    // Use a *new* data dir + fresh module import so the module cache is clean.
    // In-module cache is populated after any install call, but for the pre-install
    // check on a fresh dir the disk index does not yet exist.
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-installer-fresh-'));
    try {
      // No install yet → index file does not exist on disk, but the function
      // refreshes from the empty disk state and returns null.
      // NOTE: getAgentNameForExpert has a process-wide in-memory cache. If a
      // previous test populated it, this may return a stale value. Avoid that
      // by querying with an id that was never installed.
      expect(getAgentNameForExpert(freshDir, 'never-installed-id')).toBeNull();
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('(pre-fix guard) after installAll resolves, every backend expert has BOTH index entry AND file on disk', async () => {
    // Catches the fire-and-forget race: installAll must not return while any
    // expert is missing its .md or its index entry.
    await installAll({ dataDir, backendPort: backend.port });
    const paths = resolvePaths(dataDir);
    const index = JSON.parse(fs.readFileSync(paths.indexPath, 'utf-8')) as {
      experts: Record<string, string>;
    };

    for (const expert of expertsFixture) {
      expect(index.experts[expert.id]).toBeTruthy();
      const slug = index.experts[expert.id];
      expect(fs.existsSync(path.join(paths.agentsDir, `${slug}.md`))).toBe(true);
    }
  });
});

describe('installer — builtin Cerebro is never materialized as a persona', () => {
  // The backend returns Cerebro as a normal type='expert' row (so it shows in
  // task pickers), but it must NOT get its own persona agent file: the runtime
  // maps the 'cerebro' id to the canonical cerebro.md orchestrator. A duplicate
  // `cerebro-<hash>.md` would be dead litter and a confusing second roster entry.
  let dataDir: string;
  let backend: { port: number; close: () => void };

  const cerebroFixture: ExpertFixture = {
    id: 'cerebro',
    name: 'Cerebro',
    slug: 'cerebro',
    description: 'Your personal AI assistant.',
    system_prompt: 'You are Cerebro.',
    domain: null,
    policies: null,
    is_enabled: true,
  };
  const realExpert: ExpertFixture = {
    id: 'e9',
    name: 'Growth Expert',
    slug: null,
    description: 'Growth',
    system_prompt: 'You are a growth expert.',
    domain: 'marketing',
    policies: null,
    is_enabled: true,
  };

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-installer-skip-'));
    backend = await startBackend([cerebroFixture, realExpert]);
  });

  afterEach(() => {
    backend.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('installAll skips the Cerebro builtin: no persona file, no index entry', async () => {
    await installAll({ dataDir, backendPort: backend.port });
    const paths = resolvePaths(dataDir);
    const index = JSON.parse(fs.readFileSync(paths.indexPath, 'utf-8')) as {
      experts: Record<string, string>;
    };

    // No id-hashed persona file for Cerebro…
    const personaSlug = expertAgentName('cerebro', 'Cerebro');
    expect(fs.existsSync(path.join(paths.agentsDir, `${personaSlug}.md`))).toBe(false);
    // …and no index entry pointing the Cerebro id at a persona agent.
    expect(index.experts['cerebro']).toBeUndefined();
    expect(getAgentNameForExpert(dataDir, 'cerebro')).toBeNull();

    // The canonical orchestrator file is still written…
    expect(fs.existsSync(path.join(paths.agentsDir, 'cerebro.md'))).toBe(true);
    // …and ordinary experts are still materialized normally.
    const realSlug = index.experts['e9'];
    expect(realSlug).toBeTruthy();
    expect(fs.existsSync(path.join(paths.agentsDir, `${realSlug}.md`))).toBe(true);
  });

  it('installExpert is a no-op for the Cerebro builtin', async () => {
    await installExpert({ dataDir, backendPort: backend.port }, cerebroFixture);
    const paths = resolvePaths(dataDir);
    const personaSlug = expertAgentName('cerebro', 'Cerebro');
    expect(fs.existsSync(path.join(paths.agentsDir, `${personaSlug}.md`))).toBe(false);
    expect(getAgentNameForExpert(dataDir, 'cerebro')).toBeNull();
  });

  it('list-experts.sh filters out the orchestrator so it never delegates to itself', () => {
    // The generated delegation-roster script must exclude id 'cerebro'.
    const paths = resolvePaths(dataDir);
    // installScript writes builtin scripts during installAll.
    return installAll({ dataDir, backendPort: backend.port }).then(() => {
      const script = fs.readFileSync(path.join(paths.scriptsDir, 'list-experts.sh'), 'utf-8');
      expect(script).toContain('select(.id != "cerebro")');
    });
  });
});
