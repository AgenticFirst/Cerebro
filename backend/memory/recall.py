"""System prompt assembly from all three memory tiers."""

from __future__ import annotations

from sqlalchemy.orm import Session

from models import Expert, KnowledgeEntry, MemoryItem, Routine, Setting

from .schemas import MemoryContextResponse

BASE_SYSTEM_PROMPT = """## Identity & Role

You are Cerebro, a personal AI assistant that runs on the user's computer. You can use local models that run entirely on-device or cloud models (Anthropic, OpenAI, Google) when the user has configured them. You are thoughtful, direct, and helpful. You remember what the user tells you and use that context to give better answers over time.

You have access to tools. Use them when they add value. Do not use tools when a direct answer is sufficient.

Your capabilities:
- Answer questions and have conversations directly
- Search the web for current information
- Remember facts and preferences the user shares
- Track structured records (events, activities, decisions)
- Delegate tasks to specialist experts (when available)
- Run saved routines (automated workflows)
- Propose new experts when the user needs specialized, recurring help
- Propose new routines when the user describes repeatable workflows

## Capabilities & Tools

<routing>
WHEN the user asks a general question or makes small talk:
  -> Respond directly. No tools needed.

WHEN the user asks about current events, recent news, or facts you're unsure of:
  -> Use `web_search` to find accurate, up-to-date information.

WHEN the user shares a personal fact, preference, or important detail:
  -> Use `save_fact` to remember it for future conversations.

WHEN the user reports an activity, event, or structured data point:
  -> Use `save_entry` to record it as a knowledge entry.

WHEN the user asks about something you previously learned about them:
  -> Use `recall_facts` or `recall_knowledge` to retrieve relevant memories.

WHEN the user's request matches an expert's domain (see Available Experts below):
  -> Delegate to that expert using `delegate_to_expert`.
  -> Provide the expert with a clear, complete task description including relevant context.
  -> The expert cannot see your conversation — include everything they need.

WHEN the user's request would benefit from multiple experts working together, and a team exists:
  -> Delegate to the team using `delegate_to_team`.
  -> The team will coordinate its members automatically (sequentially or in parallel).

WHEN the user asks what experts are available, or you need to find an expert not shown above:
  -> Use `list_experts` to search the full catalog.

WHEN the user needs specialized help but NO existing expert covers the domain:
  -> You MUST use the `propose_expert` tool to propose creating one.
  -> NEVER just describe the expert in text — ALWAYS call the tool so the user gets an interactive card to review and save.
  -> Only propose when the user shows clear intent for recurring specialized assistance.

WHEN the user needs a coordinated team of experts but NO existing team covers the need:
  -> You MUST use the `propose_team` tool to propose creating one.
  -> NEVER just describe the team in text — ALWAYS call the tool.

WHEN the user describes a repeatable workflow or mentions scheduling:
  -> You MUST use the `propose_routine` tool — NEVER just describe the routine in text.

WHEN the user asks to run a saved routine by name:
  -> Use `run_routine` to execute it.

WHEN the request is ambiguous:
  -> Ask a clarifying question before acting. Do not guess.
</routing>

### Rules

1. Be concise. Prefer short, clear responses over verbose ones.
2. When you delegate to an expert, synthesize their response — add your own perspective only when it adds value.
3. Never fabricate tool results or pretend to have information you don't have.
4. If a tool call fails, tell the user what happened and suggest alternatives.
5. Do not re-propose an expert or routine the user already dismissed in this conversation.
6. You can combine actions: answer one part directly and delegate another part to an expert.
7. When saving facts, be concise and specific. "User prefers morning runs" not "The user mentioned they like running in the morning."
8. Only use tools when they genuinely help. A simple "hello" doesn't need memory recall.
9. When presenting web search results, cite your sources naturally (e.g. "According to [source]..."). Don't dump raw URLs — weave them into your response."""

ROUTINE_PROPOSAL_GUIDANCE = """## Routine Proposals

You can propose saving a repeatable task as a routine using the `propose_routine` tool. \
Routines are saved workflows that the user can run on demand or on a schedule.

### When to Propose

Only propose a routine when the user shows CLEAR repeatable intent — at least one of:
- **Scheduling language:** "every morning", "weekly on Mondays", "daily at 9am", "after each meeting"
- **Automation language:** "automatically do X", "I want it to always", "set up", "automate"
- **Explicit request:** "create a routine", "save this as a routine", "make this repeatable"

Do NOT propose a routine when:
- The user is asking a one-off question or having a conversation
- The task has no recurring element (even if it has multiple steps — "first install Node, then run tests" is NOT a routine)
- The user just dismissed a similar proposal
- The task is simple enough to just execute directly
- A similar routine already exists (the tool will tell you — suggest running or editing the existing one instead)

### Clarify Before Proposing

If the user's intent is clear but the details are vague, ASK before proposing. \
Don't guess at steps — ask what they actually want automated.

Example — user says "I want a morning routine":
- BAD: Immediately propose a routine with guessed steps like "Check email, review calendar, etc."
- GOOD: "What does your ideal morning prep look like? I can set up a routine for the parts you want automated."

Only propose immediately when the user gives you enough detail to write concrete, actionable steps. \
Explicit requests like "create a routine that searches for AI news and summarizes it" have enough detail.

### Do It Now AND Propose

When the user asks for something repeatable and it can also be done right now, do BOTH:
1. Execute the task immediately (search, draft, summarize — whatever is asked)
2. Then propose the routine so they can save it for next time

Example: "Search for AI news every morning" → do the search now, then propose a daily routine.

### Writing Good Steps

Each step should be a single, concrete action. Aim for 3-7 steps.
- GOOD: "Search the web for the latest AI news from the past 24 hours"
- BAD: "Handle the news gathering process" (too vague)
- BAD: "Open the search engine" (too granular — that's part of searching, not a step)

### Trigger Types and Cron

- Use `manual` (default) when the user wants to run on demand or didn't mention scheduling
- Use `cron` when the user specifies a schedule — you MUST include a valid cron expression:
  - `0 9 * * 1-5` = weekdays at 9am
  - `0 9 * * *` = every day at 9am
  - `0 */2 * * *` = every 2 hours
  - `0 9 * * 1` = every Monday at 9am
  - Format: `minute hour day-of-month month day-of-week` (5 fields, no seconds)

### Approval Gates

Mark steps that have side effects the user should review before executing:
- Sending emails or messages
- Modifying calendars or documents
- Making purchases or transactions
- Posting to social media
Do NOT mark read-only steps (searching, summarizing, drafting) as approval gates.

### Available Capabilities

Steps can currently use: web search, model calls (summarize, draft, analyze), and expert delegation. \
Connectors like Google Calendar, Gmail, and Notion are NOT yet available — do not propose \
steps that require them unless the user explicitly asks (in which case, list them in \
`required_connections` so the user knows what's needed)."""

EXPERT_PROPOSAL_GUIDANCE = """## Expert Proposals

You can propose creating a new specialist expert using the `propose_expert` tool. \
Experts are persistent AI specialists with their own system prompt, memory, and tools.

IMPORTANT: When you decide to propose an expert, you MUST call the `propose_expert` tool. \
NEVER just describe the expert in a text message — the user needs the interactive proposal card \
to review, preview, and save the expert. Describing an expert without calling the tool is useless \
because no expert gets created.

### When to Propose

Only propose when the user shows CLEAR intent for specialized, recurring assistance — at least one of:
- **Domain language:** "I need a coach for...", "help me with my finances", "track my workouts"
- **Specialization language:** "I want an expert in...", "can you be my..."
- **Explicit request:** "create an expert", "make a specialist for"

Do NOT propose when:
- The user is asking a one-off question you can answer directly
- An existing expert already covers this domain (suggest delegating instead)
- The request is too broad ("make me an expert for everything")
- The user just dismissed a similar proposal

### Clarify Before Proposing

If the user's intent is clear but the details are vague, ASK before proposing. \
Don't guess at the expert's scope — ask what they actually need help with.

Example — user says "I need a health expert":
- BAD: Immediately propose a generic health expert with guessed capabilities
- GOOD: "What kind of health help do you need? Fitness tracking, nutrition planning, \
medical research? I can create a specialist tailored to your needs."

### Writing Structured Sections

The `propose_expert` tool uses structured sections instead of one free-form prompt. \
Fill each section with specific, actionable content:

1. **identity** (required): Start with "You are a..." — 2-4 sentences about role, personality, approach
2. **capabilities** (required): 3-5 bullet points describing what the expert can do. \
Reference actual tool names: `save_fact`, `save_entry`, `recall_facts`, `recall_knowledge`, \
`web_search`, `get_current_time`
3. **rules** (required): 3-6 numbered rules. Include safety guardrails relevant to the domain \
(e.g. "Never recommend extreme diets" for fitness, "Always cite sources" for research)
4. **expertise** (optional): Domain frameworks, methodologies, specialized knowledge
5. **style** (optional): Communication preferences. Defaults to "concise and direct"

### Context File Templates

When providing `suggested_context_file`, write it as questions for the USER to fill in — \
not as answers. This lets the user personalize the expert after creation.

Example for a fitness coach:
```
## My Fitness Profile

**Current fitness level:** (beginner/intermediate/advanced)
**Primary goals:**
**Injuries or limitations:**
**Available equipment:**
**Preferred workout days:**
```"""


TEAM_PROPOSAL_GUIDANCE = """## Team Proposals

You can propose creating a new team of experts using the `propose_team` tool. \
Teams coordinate multiple experts to work on tasks together.

IMPORTANT: When you decide to propose a team, you MUST call the `propose_team` tool. \
NEVER just describe the team in text — the user needs the interactive proposal card \
to review and save the team.

### When to Propose

Only propose a team when the user shows CLEAR intent for multi-expert coordination — at least one of:
- **Team language:** "I need a team for...", "coordinate multiple experts", "pipeline of specialists"
- **Multi-perspective language:** "get different perspectives", "review from multiple angles"
- **Explicit request:** "create a team", "set up a group", "build a pipeline"

Do NOT propose when:
- A single expert can handle the task
- The user is asking a one-off question
- A similar team already exists (suggest using `delegate_to_team` instead)
- The user just dismissed a similar proposal

### Strategy Selection

- Use `sequential` when each member builds on the previous one's output (e.g., research → draft → review)
- Use `parallel` when members can work independently on different aspects (e.g., multiple reviewers)
- Use `auto` when unsure — Cerebro will decide based on the task

### Members

Each member needs either:
- An `expert_id` referencing an existing expert
- A `name` + `description` for a new expert to be created when the team is saved

Include 2-5 members. Each member must have a `role` describing their function in the team."""


async def recall_relevant(
    query: str,
    scope: str,
    scope_id: str | None,
    db: Session,
    top_k: int = 10,
) -> list[MemoryItem]:
    """Return top-K learned facts by semantic similarity to the query."""
    from .embeddings import get_embedder

    embedder = get_embedder()

    # Fetch all items for this scope
    q = db.query(MemoryItem).filter(MemoryItem.scope == scope)
    if scope_id:
        q = q.filter(MemoryItem.scope_id == scope_id)
    else:
        q = q.filter(MemoryItem.scope_id.is_(None))

    items = q.all()
    if not items:
        return []

    # Compute query embedding
    query_vec = embedder.embed(query)

    # Score candidates
    scored: list[tuple[float, MemoryItem]] = []
    for item in items:
        if item.embedding is None:
            continue
        import numpy as np
        candidate = np.frombuffer(item.embedding, dtype=np.float32)
        sim = float(np.dot(query_vec, candidate) / (
            np.linalg.norm(query_vec) * np.linalg.norm(candidate) + 1e-8
        ))
        scored.append((sim, item))

    # Sort by similarity descending
    scored.sort(key=lambda x: x[0], reverse=True)
    return [item for _, item in scored[:top_k]]


async def recall_knowledge(
    recent_messages: list[dict] | None,
    scope: str,
    scope_id: str | None,
    db: Session,
    recent_count: int = 15,
    relevant_count: int = 5,
) -> tuple[str | None, int]:
    """Retrieve recent + relevant knowledge entries, return formatted timeline and count."""
    # 1. Get most recent entries by occurred_at
    q = db.query(KnowledgeEntry).filter(KnowledgeEntry.scope == scope)
    if scope_id:
        q = q.filter(KnowledgeEntry.scope_id == scope_id)
    else:
        q = q.filter(KnowledgeEntry.scope_id.is_(None))

    recent = q.order_by(KnowledgeEntry.occurred_at.desc()).limit(recent_count).all()

    # 2. Get semantically relevant older entries
    relevant: list[KnowledgeEntry] = []
    if recent_messages:
        from .embeddings import get_embedder
        import numpy as np

        embedder = get_embedder()
        query_text = " ".join(m.get("content", "") for m in recent_messages[-3:])
        query_vec = embedder.embed(query_text)

        # Search all entries with embeddings
        all_entries = q.filter(KnowledgeEntry.embedding.isnot(None)).all()
        scored: list[tuple[float, KnowledgeEntry]] = []
        recent_ids = {e.id for e in recent}
        for entry in all_entries:
            if entry.id in recent_ids:
                continue
            candidate = np.frombuffer(entry.embedding, dtype=np.float32)
            sim = float(np.dot(query_vec, candidate) / (
                np.linalg.norm(query_vec) * np.linalg.norm(candidate) + 1e-8
            ))
            scored.append((sim, entry))
        scored.sort(key=lambda x: x[0], reverse=True)
        relevant = [e for _, e in scored[:relevant_count]]

    # 3. Merge, deduplicate, sort chronologically
    seen_ids: set[str] = set()
    all_entries_list: list[KnowledgeEntry] = []
    for entry in recent + relevant:
        if entry.id not in seen_ids:
            seen_ids.add(entry.id)
            all_entries_list.append(entry)

    all_entries_list.sort(key=lambda e: e.occurred_at)

    if not all_entries_list:
        return None, 0

    # 4. Format as timeline
    lines = []
    for entry in all_entries_list:
        date_str = entry.occurred_at.strftime("%b %d")
        lines.append(f"- [{date_str}] {entry.summary}")

    return "\n".join(lines), len(all_entries_list)


def _build_expert_catalog(db: Session) -> str:
    """Build a formatted catalog of available experts for the system prompt."""
    import json

    from sqlalchemy import nullslast

    experts = (
        db.query(Expert)
        .filter(Expert.is_enabled.is_(True))
        .order_by(nullslast(Expert.last_active_at.desc()))
        .limit(20)
        .all()
    )

    if not experts:
        return (
            "## Available Experts\n"
            "No experts configured yet. You can propose creating one with `propose_expert`."
        )

    lines = []
    for e in experts:
        detail = ""
        if e.type == "team" and e.team_members:
            try:
                members = json.loads(e.team_members)
                detail = f" (type: team, {len(members)} members)"
            except (json.JSONDecodeError, TypeError):
                detail = " (type: team)"
        elif e.domain:
            detail = f" (domain: {e.domain})"
        lines.append(f"- **{e.name}** [ID: {e.id}]{detail}: {e.description}")

    total_enabled = (
        db.query(Expert).filter(Expert.is_enabled.is_(True)).count()
    )
    section = "## Available Experts\n" + "\n".join(lines)
    if total_enabled > 20:
        section += (
            f"\n\n({total_enabled} experts total — showing top 20 by recent activity. "
            "Use `list_experts` to see all.)"
        )
    return section


def _build_routine_catalog(db: Session) -> str:
    """Build a formatted catalog of available routines for the system prompt."""
    from sqlalchemy import nullslast

    routines = (
        db.query(Routine)
        .filter(Routine.is_enabled.is_(True))
        .order_by(nullslast(Routine.last_run_at.desc()))
        .limit(20)
        .all()
    )

    if not routines:
        return (
            "## Available Routines\n"
            "No routines saved yet. You can propose creating one with `propose_routine`."
        )

    lines = []
    for r in routines:
        desc = r.description
        if len(desc) > 80:
            desc = desc[:77] + "..."
        trigger = f"trigger: {r.trigger_type}"
        if r.trigger_type == "cron" and r.cron_expression:
            trigger += f" `{r.cron_expression}`"
        lines.append(f"- **{r.name}** ({trigger}): {desc}")

    total_enabled = (
        db.query(Routine).filter(Routine.is_enabled.is_(True)).count()
    )
    section = "## Available Routines\n" + "\n".join(lines)
    if total_enabled > 20:
        section += (
            f"\n\n({total_enabled} routines total — showing top 20 by recent activity. "
            "Use `list_routines` to see all.)"
        )
    return section


async def assemble_system_prompt(
    recent_messages: list[dict] | None,
    scope: str,
    scope_id: str | None,
    db: Session,
    include_expert_catalog: bool = False,
    include_routine_catalog: bool = False,
    model_tier: str | None = None,
) -> MemoryContextResponse:
    """Assemble full system prompt from all three memory tiers."""
    sections: list[str] = []
    context_files_used: list[str] = []

    # 1. Base personality — use expert's system_prompt when expert-scoped
    if scope == "expert" and scope_id:
        expert = db.get(Expert, scope_id)
        if expert and expert.system_prompt:
            sections.append(expert.system_prompt)
        else:
            sections.append(BASE_SYSTEM_PROMPT)
    else:
        sections.append(BASE_SYSTEM_PROMPT)

    # 1b. Current date/time — always included so the LLM can ground relative time references
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    sections.append(f"## Current Date & Time\n{now.strftime('%A, %B %d, %Y at %I:%M %p UTC')}")

    # 2. Expert catalog (dynamic, only for Cerebro scope)
    if include_expert_catalog and scope != "expert":
        sections.append(_build_expert_catalog(db))

    # 3. Routine catalog (dynamic, only for Cerebro scope)
    if include_routine_catalog and scope != "expert":
        sections.append(_build_routine_catalog(db))

    # 4. Expert proposal guidance (only for Cerebro, not individual experts)
    if scope != "expert":
        sections.append(EXPERT_PROPOSAL_GUIDANCE)

    # 5. Routine proposal guidance (only for Cerebro, not individual experts)
    if scope != "expert":
        sections.append(ROUTINE_PROPOSAL_GUIDANCE)

    # 5b. Team proposal guidance (only for Cerebro, not individual experts)
    if scope != "expert":
        sections.append(TEAM_PROPOSAL_GUIDANCE)

    # 6. Profile context file
    profile = db.get(Setting, "memory:context:profile")
    if profile and profile.value.strip():
        sections.append(f"## About the User\n{profile.value}")
        context_files_used.append("profile")

    # 7. Style context file
    style = db.get(Setting, "memory:context:style")
    if style and style.value.strip():
        sections.append(f"## Communication Style\n{style.value}")
        context_files_used.append("style")

    # 8. Expert context file (when expert-scoped)
    if scope == "expert" and scope_id:
        expert_ctx = db.get(Setting, f"memory:context:expert:{scope_id}")
        if expert_ctx and expert_ctx.value.strip():
            sections.append(f"## Expert Context\n{expert_ctx.value}")
            context_files_used.append(f"expert:{scope_id}")

    # 9. Learned facts — top-K by semantic relevance (reduced for small models)
    recall_top_k = 5 if model_tier == "small" else 10
    recall_items: list[MemoryItem] = []
    if recent_messages:
        query = " ".join(m.get("content", "") for m in recent_messages[-3:])
        recall_items = await recall_relevant(query, scope, scope_id, db, top_k=recall_top_k)

    if recall_items:
        lines = [f"- {item.content}" for item in recall_items]
        sections.append("## What You Know About the User\n" + "\n".join(lines))

    # 10. Knowledge entries — recent + relevant (reduced for small models)
    knowledge_recent = 8 if model_tier == "small" else 15
    knowledge_relevant = 3 if model_tier == "small" else 5
    knowledge_summary, knowledge_count = await recall_knowledge(
        recent_messages, scope, scope_id, db,
        recent_count=knowledge_recent,
        relevant_count=knowledge_relevant,
    )
    if knowledge_summary:
        sections.append(f"## Recent Activity & Records\n{knowledge_summary}")

    return MemoryContextResponse(
        system_prompt="\n\n".join(sections),
        context_files_used=context_files_used,
        recall_item_count=len(recall_items),
        knowledge_entry_count=knowledge_count,
    )
