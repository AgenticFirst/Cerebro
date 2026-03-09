/**
 * MCP Server Script Generator — produces a self-contained Node.js script
 * that implements the MCP stdio protocol (JSON-RPC 2.0 over stdin/stdout).
 *
 * The generated script uses only Node built-ins (readline, http, process)
 * and bridges Claude Code tool calls to Cerebro's FastAPI backend.
 */

/**
 * Returns the full source of a Node.js MCP stdio server as a string.
 *
 * The script reads env vars at runtime:
 *   CEREBRO_PORT          — backend port
 *   CEREBRO_SCOPE         — "personal" or "expert"
 *   CEREBRO_SCOPE_ID      — expert ID or empty
 *   CEREBRO_CONVERSATION_ID — current conversation ID
 */
export function getMcpServerScript(): string {
  // The script is a template literal so we can keep it readable.
  // No interpolation needed — all config comes from env vars at runtime.
  return `#!/usr/bin/env node
"use strict";

const http = require("http");
const readline = require("readline");

const PORT = process.env.CEREBRO_PORT || "8000";
const SCOPE = process.env.CEREBRO_SCOPE || "personal";
const SCOPE_ID = process.env.CEREBRO_SCOPE_ID || "";
const CONVERSATION_ID = process.env.CEREBRO_CONVERSATION_ID || "";

// ── JSON-RPC helpers ──────────────────────────────────────────

function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

// ── HTTP helper ───────────────────────────────────────────────

function backendRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const options = {
      hostname: "127.0.0.1",
      port: parseInt(PORT, 10),
      path,
      method,
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    };
    if (bodyStr) {
      options.headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
    }
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk.toString(); });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Tool definitions ──────────────────────────────────────────

const TOOLS = [
  {
    name: "cerebro_save_fact",
    description: "Save a learned fact or user preference to Cerebro's memory. Use this when the user shares personal info, preferences, or asks you to remember something.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The fact to remember. Be concise and specific, e.g. 'User prefers dark mode' not 'The user mentioned they like dark mode'.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "cerebro_save_entry",
    description: "Save a structured knowledge entry (event, activity, decision, record) to Cerebro's memory.",
    inputSchema: {
      type: "object",
      properties: {
        entry_type: {
          type: "string",
          description: "Type of entry: activity, event, decision, goal, health, finance, etc.",
        },
        summary: {
          type: "string",
          description: "Short summary of the entry.",
        },
        content: {
          type: "string",
          description: "JSON string with structured details about the entry.",
        },
        occurred_at: {
          type: "string",
          description: "ISO 8601 timestamp of when the entry occurred. Defaults to now.",
        },
      },
      required: ["entry_type", "summary"],
    },
  },
  {
    name: "cerebro_recall_facts",
    description: "Search Cerebro's learned facts by keyword. Use this to recall what you know about the user.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Search query to find relevant facts.",
        },
      },
      required: ["search"],
    },
  },
  {
    name: "cerebro_recall_knowledge",
    description: "Search Cerebro's knowledge entries (events, activities, records) by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Search query to find relevant knowledge entries.",
        },
      },
      required: ["search"],
    },
  },
  {
    name: "cerebro_web_search",
    description: "Search the web for current information using Tavily. Use for current events, recent data, or facts you're unsure about.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results (default: 5).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "cerebro_get_current_time",
    description: "Get the current date and time.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "cerebro_list_experts",
    description: "List all available experts in Cerebro. Use this to see what specialists are available before creating a new one.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Optional search query to filter experts by name or description.",
        },
      },
    },
  },
  {
    name: "cerebro_create_expert",
    description: "Create a new specialist expert in Cerebro. Use when the user needs recurring, domain-specific help that no existing expert covers. Provide structured sections that will be assembled into a system prompt.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short descriptive name (e.g. 'Fitness Coach', 'Code Reviewer').",
        },
        description: {
          type: "string",
          description: "Brief description of what this expert does (1-2 sentences).",
        },
        domain: {
          type: "string",
          description: "Primary domain or area of expertise (e.g. 'fitness', 'software engineering').",
        },
        identity: {
          type: "string",
          description: "Identity paragraph (2-4 sentences). Start with 'You are a...' describing the expert's role, personality, and approach.",
        },
        capabilities: {
          type: "string",
          description: "Capabilities (3-5 bullet points starting with '- '). Describe what the expert can do.",
        },
        rules: {
          type: "string",
          description: "Rules (3-6 numbered rules). Include safety guardrails relevant to the domain.",
        },
        expertise: {
          type: "string",
          description: "Optional domain knowledge — key frameworks, methodologies, specialized knowledge.",
        },
        style: {
          type: "string",
          description: "Optional communication style. Default: 'Be concise and direct.'",
        },
        suggested_context_file: {
          type: "string",
          description: "Optional markdown template for the expert's context file. Write as questions for the user to fill in.",
        },
      },
      required: ["name", "description", "domain", "identity", "capabilities", "rules"],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────

async function handleToolCall(name, args) {
  switch (name) {
    case "cerebro_save_fact": {
      const res = await backendRequest("POST", "/memory/items", {
        scope: SCOPE,
        scope_id: SCOPE_ID || null,
        content: args.content,
        source_conversation_id: CONVERSATION_ID || null,
      });
      if (res.status === 201 || res.status === 200) {
        return { content: [{ type: "text", text: "Fact saved: " + args.content }] };
      }
      return { content: [{ type: "text", text: "Failed to save fact: " + JSON.stringify(res.body) }], isError: true };
    }

    case "cerebro_save_entry": {
      const occurredAt = args.occurred_at || new Date().toISOString();
      const content = args.content || JSON.stringify({ summary: args.summary });
      const res = await backendRequest("POST", "/memory/knowledge", {
        scope: SCOPE,
        scope_id: SCOPE_ID || null,
        entry_type: args.entry_type,
        summary: args.summary,
        content: content,
        occurred_at: occurredAt,
        source: "claude_code",
        source_conversation_id: CONVERSATION_ID || null,
      });
      if (res.status === 201 || res.status === 200) {
        return { content: [{ type: "text", text: "Entry saved: " + args.summary }] };
      }
      return { content: [{ type: "text", text: "Failed to save entry: " + JSON.stringify(res.body) }], isError: true };
    }

    case "cerebro_recall_facts": {
      const query = new URLSearchParams({
        scope: SCOPE,
        search: args.search,
        limit: "20",
      });
      if (SCOPE_ID) query.set("scope_id", SCOPE_ID);
      const res = await backendRequest("GET", "/memory/items?" + query.toString(), null);
      if (res.status === 200 && res.body.items) {
        if (res.body.items.length === 0) {
          return { content: [{ type: "text", text: "No facts found matching: " + args.search }] };
        }
        const facts = res.body.items.map((item) => "- " + item.content).join("\\n");
        return { content: [{ type: "text", text: "Found " + res.body.items.length + " fact(s):\\n" + facts }] };
      }
      return { content: [{ type: "text", text: "Failed to recall facts: " + JSON.stringify(res.body) }], isError: true };
    }

    case "cerebro_recall_knowledge": {
      const query = new URLSearchParams({
        scope: SCOPE,
        search: args.search,
        limit: "20",
      });
      if (SCOPE_ID) query.set("scope_id", SCOPE_ID);
      const res = await backendRequest("GET", "/memory/knowledge?" + query.toString(), null);
      if (res.status === 200 && res.body.entries) {
        if (res.body.entries.length === 0) {
          return { content: [{ type: "text", text: "No knowledge entries found matching: " + args.search }] };
        }
        const entries = res.body.entries.map((e) => "- [" + e.entry_type + "] " + e.summary).join("\\n");
        return { content: [{ type: "text", text: "Found " + res.body.entries.length + " entries:\\n" + entries }] };
      }
      return { content: [{ type: "text", text: "Failed to recall knowledge: " + JSON.stringify(res.body) }], isError: true };
    }

    case "cerebro_web_search": {
      const res = await backendRequest("POST", "/search", {
        query: args.query,
        max_results: args.max_results || 5,
        search_depth: "basic",
      });
      if (res.status === 200 && res.body.results) {
        if (res.body.results.length === 0) {
          return { content: [{ type: "text", text: "No web results found for: " + args.query }] };
        }
        const results = res.body.results.map(
          (r) => "### " + r.title + "\\n" + r.url + "\\n" + r.content
        ).join("\\n\\n");
        let text = "Web search results for \\"" + args.query + "\\":\\n\\n" + results;
        if (res.body.answer) {
          text = "**AI Summary:** " + res.body.answer + "\\n\\n" + text;
        }
        return { content: [{ type: "text", text }] };
      }
      return { content: [{ type: "text", text: "Web search failed: " + JSON.stringify(res.body) }], isError: true };
    }

    case "cerebro_get_current_time": {
      const now = new Date();
      return {
        content: [{
          type: "text",
          text: now.toLocaleDateString("en-US", {
            weekday: "long", year: "numeric", month: "long", day: "numeric",
          }) + " at " + now.toLocaleTimeString("en-US", {
            hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
          }),
        }],
      };
    }

    case "cerebro_list_experts": {
      const query = new URLSearchParams({ is_enabled: "true", limit: "50" });
      if (args.search) query.set("search", args.search);
      const res = await backendRequest("GET", "/experts?" + query.toString(), null);
      if (res.status === 200 && res.body.experts) {
        if (res.body.experts.length === 0) {
          return { content: [{ type: "text", text: "No experts found." }] };
        }
        const lines = res.body.experts.map(
          (e) => "- **" + e.name + "** [ID: " + e.id + "]" +
            (e.domain ? " (domain: " + e.domain + ")" : "") +
            ": " + e.description
        );
        return { content: [{ type: "text", text: "Available experts:\\n" + lines.join("\\n") }] };
      }
      return { content: [{ type: "text", text: "Failed to list experts: " + JSON.stringify(res.body) }], isError: true };
    }

    case "cerebro_create_expert": {
      // Check for duplicates first
      try {
        const listRes = await backendRequest("GET", "/experts?is_enabled=true&limit=200", null);
        if (listRes.status === 200 && listRes.body.experts) {
          const existing = listRes.body.experts.find(
            (e) => e.name.toLowerCase().trim() === args.name.toLowerCase().trim()
          );
          if (existing) {
            return {
              content: [{ type: "text", text: "A similar expert already exists: \\"" + existing.name + "\\" (ID: " + existing.id + "). Consider using the existing one or choosing a different name." }],
              isError: true,
            };
          }
        }
      } catch { /* non-critical */ }

      // Assemble system prompt from structured sections
      const sections = [];
      sections.push("## Identity & Role\\n" + args.identity);
      sections.push("## Capabilities\\n" + args.capabilities);
      sections.push("## Rules\\n" + args.rules);
      if (args.expertise) {
        sections.push("## Domain Knowledge\\n" + args.expertise);
      }
      sections.push("## Communication Style\\n" + (args.style || "Be concise and direct. Prefer short, clear responses over verbose ones."));
      const systemPrompt = sections.join("\\n\\n");

      // Create the expert
      const createRes = await backendRequest("POST", "/experts", {
        name: args.name,
        description: args.description,
        domain: args.domain,
        system_prompt: systemPrompt,
        source: "user",
        is_enabled: true,
      });

      if (createRes.status === 201 || createRes.status === 200) {
        const expertId = createRes.body.id;
        let result = "Expert created: \\"" + args.name + "\\" (ID: " + expertId + ")";

        // Seed context file if provided
        if (args.suggested_context_file) {
          try {
            await backendRequest("PUT", "/memory/context-files/expert:" + expertId, {
              content: args.suggested_context_file,
            });
            result += "\\nContext file template seeded. The user can customize it in Settings > Memory.";
          } catch { /* non-critical */ }
        }

        return { content: [{ type: "text", text: result }] };
      }
      return { content: [{ type: "text", text: "Failed to create expert: " + JSON.stringify(createRes.body) }], isError: true };
    }

    default:
      return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  }
}

// ── MCP Protocol Handler ──────────────────────────────────────

async function handleMessage(msg) {
  const { method, id, params } = msg;

  switch (method) {
    case "initialize":
      return jsonRpcResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cerebro-mcp", version: "1.0.0" },
      });

    case "notifications/initialized":
      // No response needed for notifications
      return null;

    case "tools/list":
      return jsonRpcResponse(id, { tools: TOOLS });

    case "tools/call": {
      const { name, arguments: args } = params;
      try {
        const result = await handleToolCall(name, args || {});
        return jsonRpcResponse(id, result);
      } catch (err) {
        return jsonRpcResponse(id, {
          content: [{ type: "text", text: "Tool error: " + (err.message || String(err)) }],
          isError: true,
        });
      }
    }

    default:
      if (id != null) {
        return jsonRpcError(id, -32601, "Method not found: " + method);
      }
      return null; // Ignore unknown notifications
  }
}

// ── Stdio Transport ───────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stdout.write(
      jsonRpcError(null, -32700, "Parse error") + "\\n"
    );
    return;
  }

  const response = await handleMessage(msg);
  if (response) {
    process.stdout.write(response + "\\n");
  }
});

rl.on("close", () => {
  process.exit(0);
});

// Prevent unhandled rejection crashes
process.on("unhandledRejection", (err) => {
  process.stderr.write("MCP server error: " + String(err) + "\\n");
});
`;
}
