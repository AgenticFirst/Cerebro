# Memory System

## Problem Statement

Every Cerebro conversation starts from zero. The AI has no knowledge of who the user is, what they care about, or how they like to communicate. Users re-explain themselves constantly — their role, preferences, ongoing projects, tone expectations.

But knowing *who the user is* isn't enough. A running coach that knows "User is training for a marathon" but can't see their run logs, training plan adherence, or weekly mileage is useless. Real experts need **ongoing domain knowledge** — structured records that accumulate from connected services and conversations, enabling coaching, trend analysis, and plan tracking across sessions.

Memory is also foundational infrastructure. Experts (roadmap #4) and Routines (#6) each require scoped memory. Building the memory layer now with extensible scoping means those features plug in cleanly later.

## Design Principles

1. **Local-first** — Everything works offline. No external service required for any memory operation.
2. **User sovereignty** — Users can see, edit, and delete everything Cerebro remembers. No hidden state.
3. **Non-blocking** — Memory extraction never slows down the chat experience.
4. **Portable** — All memory lives in SQLite alongside existing data. Copy the DB, copy the brain.
5. **Incremental** — The system works with zero memory configured and gets better as it accumulates.
6. **Domain-agnostic** — The knowledge system works for any expert domain (fitness, finance, health, habits, research) without domain-specific schemas.

## Architecture Overview

Memory has three tiers, each solving a distinct problem:

| Tier | What it stores | Who writes it | Example |
|------|---------------|---------------|---------|
| **Context Files** | Markdown documents describing the user and their preferences | User, via Settings editor | "I'm training for the Boston Marathon in April. I run 5x/week." |
| **Learned Facts** | Concise facts, preferences, and patterns auto-extracted from conversations | System, after each assistant response | "User prefers morning runs" / "User's goal pace is 4:30/km" |
| **Knowledge Entries** | Structured domain records that experts accumulate over time from connectors and conversations | Experts + Connectors + Routines | Run log: 5K, 28:03, avg HR 145, "felt strong" / Expense: $42 groceries |

### How the Three Tiers Work Together

Consider a user with a Running Coach expert connected to Strava:

1. **Context file** (`experts/running-coach/context.md`): The user writes their marathon goal, race date, training philosophy, injury history. This is stable, user-authored, and rarely changes.

2. **Learned facts** (auto-extracted from chat): Over conversations, the system picks up "User prefers to run in the morning", "User finds tempo runs hardest", "User's rest day is Friday". These are persistent preferences that inform how the expert coaches.

3. **Knowledge entries** (accumulated domain data): Every Strava sync creates entries — distance, pace, heart rate, elevation, perceived effort. When the user says "I did a 10K tempo today, legs felt heavy", the expert extracts a structured entry. The running coach can now query: "Show me this week's mileage vs. the plan", "Is the user's avg pace trending faster?", "They missed two runs — ask about it."

This pattern works identically for any domain:
- **Personal Finance**: Context file = budget goals and accounts. Learned facts = "User is saving for a house". Knowledge entries = transactions, spending by category, investment performance.
- **Health Coach**: Context file = health conditions, medications. Learned facts = "User is vegetarian". Knowledge entries = weight measurements, meal logs, lab results.
- **Habit Tracker**: Context file = target habits. Learned facts = "User struggles with consistency on weekends". Knowledge entries = daily check-ins, streak records.

### Data Flow

```
User sends message
       |
       v
 ChatContext.tsx
 (sendMessage)
       |
       +---> POST /memory/context
       |         |
       |         v
       |    Backend assembles system prompt:
       |      1. Base Cerebro instructions
       |      2. profile.md + style.md content
       |      3. Expert context file (if expert-scoped)
       |      4. Top-K relevant learned facts
       |      5. Recent knowledge entries (for active expert)
       |         |
       |         v
       |    Returns { system_prompt: "..." }
       |
       +---> POST /cloud/chat or /models/chat
       |    (system message prepended to messages array)
       |         |
       |         v
       |    Response streams back to user
       |         |
       |         v
       +---> POST /memory/extract  (fire-and-forget, 202 Accepted)
                 |
                 v
            Background task:
              - LLM analyzes the exchange
              - Extracts learned facts -> memory_items table
              - Extracts knowledge entries -> knowledge_entries table
              - Deduplicates, computes embeddings, stores
```

### Why Server-Side Prompt Assembly

The system prompt is assembled **server-side** via `POST /memory/context`, not in the frontend. Three reasons:

1. Similarity search for learned facts requires embeddings — those live server-side.
2. Knowledge entry queries (time-range, aggregation) must run against the database.
3. Prompt engineering is a backend concern — one round-trip, testable in Python.

All three cloud adapters (Anthropic, OpenAI, Google) and the local inference engine already handle `role: "system"` messages correctly — no adapter changes needed.

## Data Models

### Tier 1: Context Files — Stored in Existing `settings` Table

Context files are markdown text stored as key-value entries using namespaced keys. No new table required.

| Key | Purpose |
|-----|---------|
| `memory:context:profile` | User-wide facts — name, role, interests, goals |
| `memory:context:style` | Communication preferences — tone, format, length |
| Future: `memory:context:expert:{id}` | Expert-specific context (training plan, budget goals, etc.) |
| Future: `memory:context:routine:{id}` | Routine-specific context |

This reuses the existing `Setting` model and `/settings/{key}` endpoints. The dedicated `/memory/context-files/*` API wraps these with validation and hides the key prefix from the frontend.

### Tier 2: Learned Facts — New `memory_items` Table

```python
class MemoryItem(Base):
    __tablename__ = "memory_items"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    scope: Mapped[str] = mapped_column(String(20), index=True)
        # "personal" | "expert" | "routine" | "team"
    scope_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
        # NULL for personal; expert/routine/team ID for scoped items
    content: Mapped[str] = mapped_column(Text)
        # Concise natural-language statement: "User prefers morning runs"
    embedding: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
        # Float32 vector as bytes via numpy.ndarray.tobytes()
    source_conversation_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    source_message_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)
```

**Scope design:** `scope` + `scope_id` together define ownership. For v1, all items are `scope="personal", scope_id=NULL`. When Experts ship, an expert's learned facts become `scope="expert", scope_id="running-coach"`. No migration needed.

**Provenance:** `source_conversation_id` and `source_message_id` let users see where a fact came from. Foreign key with `SET NULL` so deleting a conversation doesn't cascade-delete its learned facts.

### Tier 3: Knowledge Entries — New `knowledge_entries` Table

Knowledge entries are structured, timestamped domain records that experts accumulate over time. They represent *things that happened* — run logs, expenses, measurements, check-ins — as opposed to learned facts which represent *things that are true about the user*.

```python
class KnowledgeEntry(Base):
    __tablename__ = "knowledge_entries"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    scope: Mapped[str] = mapped_column(String(20), index=True)
        # "personal" | "expert" | "routine" | "team"
    scope_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
        # Which expert/routine/team owns this entry
    entry_type: Mapped[str] = mapped_column(String(50), index=True)
        # Domain-defined category: "run_log", "expense", "weight", "check_in", "note"
    occurred_at: Mapped[datetime] = mapped_column(DateTime, index=True)
        # When the event happened (NOT when it was recorded)
    summary: Mapped[str] = mapped_column(Text)
        # Human-readable one-liner: "5K run in 28:03, avg HR 145"
    content: Mapped[str] = mapped_column(Text)
        # JSON string -- flexible structured data per entry_type
        # e.g. {"distance_km": 5.0, "duration_min": 28.05, "avg_hr": 145}
    source: Mapped[str] = mapped_column(String(50))
        # Where this came from: "chat", "strava", "manual", "routine"
    embedding: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
        # For semantic search over entries
    source_conversation_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
```

**Key design choices:**

- **`occurred_at` vs `created_at`**: A Strava sync at 9pm records a run from 7am. The entry's `occurred_at` is 7am (when it happened), `created_at` is 9pm (when it was recorded). Critical for time-series queries ("what did I do this week?").

- **`content` as JSON string**: Domain-agnostic flexibility. A run log stores `{"distance_km": 5, "pace_min_km": 5.6, "avg_hr": 145}`. An expense stores `{"amount": 42.50, "currency": "USD", "category": "groceries"}`. No migrations when a new expert domain is added. The schema is defined by convention per `entry_type`, not by the database.

- **`summary` as plain text**: Always present, always human-readable. This is what appears in the UI, in the system prompt, and in search results. The LLM doesn't need to parse JSON to understand entries.

- **`entry_type` as free-form string**: Not an enum. Each expert defines its own types. A running coach uses `run_log`, `race`, `injury_note`. A finance expert uses `expense`, `income`, `investment`. The system doesn't need to know the vocabulary — it just stores and queries.

- **`source` tracks provenance**: "chat" = extracted from conversation. "strava" = synced from connector. "manual" = user created directly. "routine" = generated by a routine run. This matters for trust — users can filter by source.

### Frontend Types

```typescript
// src/types/memory.ts

export type MemoryScope = 'personal' | 'expert' | 'routine' | 'team';

export interface ContextFile {
  key: string;          // "profile", "style", or "expert:{id}"
  content: string;      // markdown
  updatedAt: string;
}

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  scopeId: string | null;
  content: string;
  sourceConversationId: string | null;
  createdAt: string;
}

export interface KnowledgeEntry {
  id: string;
  scope: MemoryScope;
  scopeId: string | null;
  entryType: string;
  occurredAt: string;
  summary: string;
  content: Record<string, unknown>;
  source: string;
  createdAt: string;
}
```

## Backend Implementation

### Module Structure

```
backend/memory/
    __init__.py
    schemas.py        # Pydantic request/response models for all three tiers
    router.py         # FastAPI router mounted at /memory
    extraction.py     # LLM-based extraction (learned facts + knowledge entries)
    embeddings.py     # Local embedding computation
    recall.py         # Similarity search + system prompt assembly
```

### API Endpoints

**Context Files (Tier 1):**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/memory/context-files` | List all context files |
| `GET` | `/memory/context-files/{key}` | Get one context file |
| `PUT` | `/memory/context-files/{key}` | Create or update a context file |
| `DELETE` | `/memory/context-files/{key}` | Delete a context file |

**Learned Facts (Tier 2):**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/memory/items` | List learned facts (filterable by scope, searchable) |
| `DELETE` | `/memory/items/{id}` | Delete a learned fact |

**Knowledge Entries (Tier 3):**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/memory/knowledge` | List entries (filterable by scope, type, date range) |
| `POST` | `/memory/knowledge` | Create an entry (for connectors and manual input) |
| `DELETE` | `/memory/knowledge/{id}` | Delete an entry |

**System:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/memory/context` | Assemble full system prompt for a chat request |
| `POST` | `/memory/extract` | Trigger async extraction from messages (returns 202) |

### Prompt Assembly (`recall.py`)

`POST /memory/context` is the critical integration point. It assembles memory from all three tiers into a single system prompt.

```python
async def assemble_system_prompt(
    recent_messages: list[dict] | None,
    scope: str,
    scope_id: str | None,
    db: Session,
) -> MemoryContextResponse:
    sections: list[str] = []
    context_files_used: list[str] = []

    # 1. Base Cerebro personality
    sections.append(BASE_SYSTEM_PROMPT)

    # 2. Profile context file
    profile = db.get(Setting, "memory:context:profile")
    if profile and profile.value.strip():
        sections.append(f"## About the User\n{profile.value}")
        context_files_used.append("profile")

    # 3. Style context file
    style = db.get(Setting, "memory:context:style")
    if style and style.value.strip():
        sections.append(f"## Communication Style\n{style.value}")
        context_files_used.append("style")

    # 4. Expert context file (when expert-scoped)
    if scope == "expert" and scope_id:
        expert_ctx = db.get(Setting, f"memory:context:expert:{scope_id}")
        if expert_ctx and expert_ctx.value.strip():
            sections.append(f"## Expert Context\n{expert_ctx.value}")
            context_files_used.append(f"expert:{scope_id}")

    # 5. Learned facts -- top-K by semantic relevance
    recall_items = []
    if recent_messages:
        query = " ".join(m["content"] for m in recent_messages[-3:])
        recall_items = await recall_relevant(query, scope, scope_id, db, top_k=10)

    if recall_items:
        lines = [f"- {item.content}" for item in recall_items]
        sections.append("## What You Know About the User\n" + "\n".join(lines))

    # 6. Knowledge entries -- recent + relevant
    knowledge_summary = await recall_knowledge(
        recent_messages, scope, scope_id, db,
        recent_count=15,
        relevant_count=5,
    )
    if knowledge_summary:
        sections.append(f"## Recent Activity & Records\n{knowledge_summary}")

    return MemoryContextResponse(
        system_prompt="\n\n".join(sections),
        context_files_used=context_files_used,
        recall_item_count=len(recall_items),
        knowledge_entry_count=knowledge_count,
    )
```

**Knowledge recall strategy (`recall_knowledge`):**

Knowledge entries use a hybrid retrieval approach because they're time-series data, not just facts:

1. **Recency window**: Always include the most recent N entries (by `occurred_at`). A running coach needs to see this week's runs regardless of semantic relevance.
2. **Semantic relevance**: If the user's current message is about pace, also pull in older entries that mention pace, even if they're from weeks ago.
3. **Formatted as a timeline**: Entries are rendered chronologically with their summaries for the system prompt.

```python
async def recall_knowledge(
    recent_messages: list[dict] | None,
    scope: str, scope_id: str | None,
    db: Session,
    recent_count: int = 15,
    relevant_count: int = 5,
) -> str | None:
    # 1. Get most recent entries by occurred_at
    recent = db.query(KnowledgeEntry).filter(
        KnowledgeEntry.scope == scope,
        KnowledgeEntry.scope_id == scope_id if scope_id
            else KnowledgeEntry.scope_id.is_(None),
    ).order_by(KnowledgeEntry.occurred_at.desc()).limit(recent_count).all()

    # 2. Get semantically relevant older entries (if query provided)
    relevant = []
    if recent_messages:
        query_text = " ".join(m["content"] for m in recent_messages[-3:])
        relevant = await similarity_search_knowledge(
            query_text, scope, scope_id, db, top_k=relevant_count
        )

    # 3. Merge, deduplicate, sort chronologically
    all_entries = deduplicate_by_id(recent + relevant)
    all_entries.sort(key=lambda e: e.occurred_at)

    if not all_entries:
        return None

    # 4. Format as timeline
    lines = []
    for entry in all_entries:
        date_str = entry.occurred_at.strftime("%b %d")
        lines.append(f"- [{date_str}] {entry.summary}")

    return "\n".join(lines)
```

### Embeddings (`embeddings.py`)

**Critical constraint: Cerebro must work fully offline.** Embeddings cannot depend on external APIs.

**Tier A — TF-IDF (zero-setup default):**
A lightweight TF-IDF vectorizer using only numpy (already a transitive dependency via llama-cpp-python). Hashing trick projects to fixed 384-dimensional dense vectors. Works immediately with no downloads.

```python
class TFIDFEmbedder:
    """Lightweight local embedder using TF-IDF with hashing trick.
    Produces fixed-dimension dense vectors from text. No model download required.
    """
    def embed(self, text: str) -> numpy.ndarray: ...
    def similarity(self, query: numpy.ndarray,
                   candidates: list[numpy.ndarray]) -> numpy.ndarray: ...
```

**Tier B — Model-based embeddings (automatic upgrade):**
When a local model is loaded (llama-cpp-python `embed()`) or a cloud provider is configured (e.g., OpenAI `text-embedding-3-small`), the `EmbeddingService` automatically upgrades:

```python
class EmbeddingService:
    """Unified embedding interface. Auto-selects best available backend.
    Priority: cloud embedding API > local model embed() > TF-IDF fallback.
    """
    async def embed(self, text: str) -> numpy.ndarray: ...
    async def embed_batch(self, texts: list[str]) -> list[numpy.ndarray]: ...
    def similarity(self, query: numpy.ndarray,
                   candidates: list[numpy.ndarray]) -> numpy.ndarray: ...
```

The storage format is identical across backends, so old embeddings can be silently re-computed when a better backend becomes available.

### Memory Extraction (`extraction.py`)

After each assistant response, the frontend fires `POST /memory/extract`. The backend extracts **both learned facts and knowledge entries** in a single LLM call using whichever model is currently active.

**Unified extraction prompt:**

```
You are a memory extraction system for Cerebro. Analyze the conversation and extract
two types of information:

1. FACTS: Persistent truths about the user (preferences, background, goals, relationships).
   - Third person: "User prefers..." not "You prefer..."
   - Must be durable -- true beyond this conversation.

2. ENTRIES: Specific events, activities, or data points the user reported.
   - Include: what happened, when (if mentioned), measurable details.
   - Examples: workouts, meals, expenses, meetings, health readings, habit check-ins.

Rules:
- Extract ONLY information the USER revealed, not the assistant's suggestions.
- NEVER extract secrets, passwords, API keys, tokens, or credentials.
- NEVER extract transient chatter ("how are you", "thanks").
- If nothing substantive was revealed, return empty arrays.

Return JSON:
{
  "facts": ["User is training for the Boston Marathon", "User prefers morning runs"],
  "entries": [
    {
      "type": "run_log",
      "occurred_at": "2026-02-28T07:00:00",
      "summary": "5K run in 28:03, avg HR 145, felt strong",
      "data": {"distance_km": 5.0, "duration_min": 28.05, "avg_hr": 145, "effort": "strong"}
    }
  ]
}

If nothing new: {"facts": [], "entries": []}
```

**Extraction flow:**

1. Build the extraction prompt from recent messages (last user + assistant pair).
2. Call the active model via a `complete()` helper that wraps the existing streaming adapters into a collected string response.
3. Parse the JSON response.
4. For each fact: run secret filter, check for duplicates (similarity > 0.9), compute embedding, store in `memory_items`.
5. For each entry: run secret filter, compute embedding on summary, store in `knowledge_entries` with `source="chat"`.

**Non-blocking execution:** The endpoint returns `202 Accepted` immediately. Extraction runs via `asyncio.create_task()`. If it fails, it fails silently — memory is non-critical.

**Connector-sourced entries:** When connectors ship (roadmap #9), they call `POST /memory/knowledge` directly to create entries. A Strava connector would create entries with `source="strava"`, `entry_type="run_log"`, structured `content` from the API response. The extraction system doesn't need to be involved — connectors produce structured data natively.

**Secret detection (post-extraction filter):**

```python
SECRET_PATTERNS = [
    r'sk-[a-zA-Z0-9]{20,}',        # OpenAI keys
    r'hf_[a-zA-Z0-9]{20,}',        # HuggingFace tokens
    r'AIza[a-zA-Z0-9_-]{35}',      # Google API keys
    r'ghp_[a-zA-Z0-9]{36}',        # GitHub PATs
    r'(?i)(api[_-]?key|secret|password|token|credential)\s*[:=]\s*\S+',
]
```

Any extracted content matching these patterns is silently discarded.

**Model access:** Extraction reuses the existing adapter functions from `backend/cloud_providers/adapters.py` (for cloud) and the inference engine (for local). A shared `complete()` helper collects the stream into a full response string.

## Frontend Implementation

### MemoryContext (`src/context/MemoryContext.tsx`)

A new React context following the established pattern of `ProviderContext.tsx` and `ModelContext.tsx`:

```typescript
interface MemoryContextValue {
  // State
  contextFiles: Record<string, ContextFile>;
  memoryItems: MemoryItem[];
  knowledgeEntries: KnowledgeEntry[];
  totalMemoryItems: number;
  totalKnowledgeEntries: number;
  isLoading: boolean;

  // Actions -- Context Files
  loadContextFile: (key: string) => Promise<void>;
  saveContextFile: (key: string, content: string) => Promise<void>;
  deleteContextFile: (key: string) => Promise<void>;

  // Actions -- Learned Facts
  loadMemoryItems: (scope?: MemoryScope, search?: string) => Promise<void>;
  deleteMemoryItem: (id: string) => Promise<void>;

  // Actions -- Knowledge Entries
  loadKnowledgeEntries: (filters?: KnowledgeFilters) => Promise<void>;
  deleteKnowledgeEntry: (id: string) => Promise<void>;

  // System prompt
  getSystemPrompt: (recentMessages: Array<{role: string; content: string}>) => Promise<string>;
}
```

**Provider nesting in `App.tsx`:**

```
ProviderProvider > ModelProvider > MemoryProvider > ChatProvider > AppLayout
```

### ChatContext Changes (`src/context/ChatContext.tsx`)

Two modifications to `sendMessage`:

**1. System prompt injection (before sending):**

```typescript
const chatMessages = [...priorMessages, { role: 'user', content }];

// Fetch assembled system prompt from memory (all three tiers)
let systemPrompt: string | null = null;
try {
  systemPrompt = await getSystemPrompt(chatMessages);
} catch {
  // Memory is non-critical -- proceed without it
}

const messagesWithMemory = systemPrompt
  ? [{ role: 'system', content: systemPrompt }, ...chatMessages]
  : chatMessages;
```

**2. Memory extraction (after response completes):**

```typescript
// After assistant message finalized in streamResponse -- fire-and-forget:
window.cerebro.invoke({
  method: 'POST',
  path: '/memory/extract',
  body: { conversation_id: convId, messages: recentPair },
}).catch(() => {});
```

### Settings Screen (`src/components/screens/SettingsScreen.tsx`)

Replaces the current `PlaceholderScreen` for `'settings'`. Same layout pattern as `IntegrationsScreen.tsx` — inner sidebar with sections.

**Sections:** Memory (the focus of this design), with placeholder slots for Appearance and About.

### Memory Section UI

The Memory section in Settings has three subsections corresponding to the three tiers:

```
Settings > Memory
===================================================

Context Files
---------------------------------------------------
+-------------------------------------+
|  Profile                     [Edit] |
|  Tell Cerebro about yourself --     |
|  your name, role, interests, and    |
|  anything you want it to always     |
|  know.                              |
+-------------------------------------+
+-------------------------------------+
|  Style                       [Edit] |
|  Define how you want Cerebro to     |
|  communicate -- tone, format,       |
|  length, preferences.               |
+-------------------------------------+

Learned Facts                   24 items
---------------------------------------------------
+-------------------------------------+
|  Search facts...                    |
+-------------------------------------+

  "User is training for the Boston Marathon"
   From: Help me plan my training  -  Feb 20
                                    [Delete]

  "User prefers morning runs"
   From: What's a good schedule  -  Feb 18
                                    [Delete]

  [Load more...]


Knowledge Entries               89 entries
---------------------------------------------------
  Scope: [All]  Type: [All]  [Search...]

  Feb 28 -- run_log
  "10K tempo run in 52:30, avg HR 158"
   Source: chat                     [Delete]

  Feb 27 -- run_log
  "Easy 5K recovery, 30:15, avg HR 128"
   Source: strava                   [Delete]

  Feb 26 -- check_in
  "Rest day, legs feeling recovered"
   Source: chat                     [Delete]

  [Load more...]
```

**Context File Editor:** Clicking "Edit" opens an inline editor — monospace `<textarea>`, Save/Cancel buttons. Placeholder guidance for new files:

```markdown
<!-- Profile: Tell Cerebro about yourself -->
<!-- Examples: -->
<!-- - I'm a software engineer at Acme Corp -->
<!-- - I'm training for the Boston Marathon in April 2026 -->
<!-- - I prefer detailed explanations with examples -->
```

**Learned Facts Viewer:** Scrollable list with text search, provenance link, delete button, pagination (50/page).

**Knowledge Entries Viewer:** Scrollable timeline with filters for scope, entry type, and text search. Each entry shows `occurred_at` date, type badge, summary, source badge, and delete button. Pagination (50/page).

### Component Structure

```
src/components/screens/
    SettingsScreen.tsx
    settings/
        MemorySection.tsx            # Container for all three subsections
        ContextFileCard.tsx          # Context file display card
        ContextFileEditor.tsx        # Inline markdown editor
        MemoryItemsList.tsx          # Learned facts list with search
        MemoryItemRow.tsx            # Individual learned fact
        KnowledgeEntriesList.tsx     # Knowledge entries timeline with filters
        KnowledgeEntryRow.tsx        # Individual knowledge entry
```

### AppLayout Change

```typescript
// src/components/layout/AppLayout.tsx
if (activeScreen === 'settings') {
  return <SettingsScreen />;
}
```

## Security

### Preventing Secrets in Memory

Three layers of defense across all tiers:

1. **Extraction prompt** — The LLM is explicitly instructed to never extract secrets, passwords, API keys, or credentials.

2. **Regex filter** — Post-extraction scan catches common secret patterns before storage. Applied to learned fact content, knowledge entry summaries, and knowledge entry data values.

3. **User oversight** — All memories across all three tiers are visible and deletable in the Settings UI.

### Content Isolation

- Items are scoped by `scope` + `scope_id`. Personal items are only queried when `scope="personal"`.
- When Expert scopes ship, an expert's memories and knowledge entries won't leak to other experts.
- The memory system has no access to the credential store (`backend/credentials.py`). The `memory:context:*` settings namespace does not overlap with any credential keys.

## Implementation Phases

Each phase delivers a working increment.

### Phase 1: Backend Memory Module + Context Files

- Create `backend/memory/` module (schemas, router with context-file CRUD)
- Add `MemoryItem` and `KnowledgeEntry` models to `backend/models.py`
- Mount memory router in `backend/main.py`
- Create `src/types/memory.ts`
- Create `src/context/MemoryContext.tsx` (context file state only)
- Wire `MemoryProvider` into `App.tsx`

**Deliverable:** Context files readable/writable via API. Tables created. No UI yet.

### Phase 2: Settings Screen + Context File Editor

- Create `SettingsScreen.tsx` with inner sidebar layout
- Create `MemorySection.tsx`, `ContextFileCard.tsx`, `ContextFileEditor.tsx`
- Update `AppLayout.tsx` to route `'settings'` to `SettingsScreen`

**Deliverable:** Users can view and edit profile.md and style.md from Settings.

### Phase 3: System Prompt Injection

- Create `backend/memory/recall.py` with `assemble_system_prompt()` (context files only initially)
- Add `POST /memory/context` endpoint
- Modify `sendMessage` in `ChatContext.tsx` to prepend system message

**Deliverable:** Context file content is injected into every conversation. Memory goes live.

### Phase 4: Semantic Recall + Knowledge Extraction

- Create `backend/memory/embeddings.py` (TF-IDF + EmbeddingService)
- Create `backend/memory/extraction.py` (unified extraction for both facts and entries + secret filter + dedup)
- Add `POST /memory/extract`, `GET /memory/items`, `DELETE /memory/items/{id}` endpoints
- Add `GET /memory/knowledge`, `POST /memory/knowledge`, `DELETE /memory/knowledge/{id}` endpoints
- Wire both learned facts and knowledge entries into `assemble_system_prompt`
- Add `triggerExtraction()` to `ChatContext.tsx` after response completion

**Deliverable:** Facts and knowledge entries automatically extracted from conversations and recalled in future ones.

### Phase 5: Memory Viewer UI

- Create `MemoryItemsList.tsx`, `MemoryItemRow.tsx` (learned facts viewer)
- Create `KnowledgeEntriesList.tsx`, `KnowledgeEntryRow.tsx` (knowledge entries timeline)
- Add search, scope/type filters, pagination, delete for both sections
- Wire into `MemorySection.tsx`

**Deliverable:** Users can view, search, filter, and delete all memories from Settings.

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Three-tier memory | Context Files + Learned Facts + Knowledge Entries | "Who the user is" (static), "what we've learned" (facts), and "what's happened" (records) are fundamentally different data with different access patterns |
| Context file storage | SQLite `settings` table | Portable, no sandbox issues, reuses existing infrastructure |
| Knowledge entry content | JSON string in a `content` column | Domain-agnostic — any expert can store its own schema without migrations |
| `occurred_at` separate from `created_at` | Explicit column | Critical for time-series: a Strava sync at 9pm records a run from 7am |
| Default embedding method | TF-IDF with hashing trick | Zero-setup, works offline, good enough for short text |
| Prompt assembly | Server-side `POST /memory/context` | Embeddings + DB queries live server-side, one round-trip |
| Extraction timing | Async fire-and-forget | LLM calls take 1-10s — can't block chat |
| Unified extraction | Single LLM call extracts both facts and entries | Cheaper and simpler than two separate calls |
| Scope design | `scope` + `scope_id` on both tables | Extends to Expert/Routine/Team without migration |

## Files Modified

| File | Change |
|------|--------|
| `backend/models.py` | Add `MemoryItem` and `KnowledgeEntry` models |
| `backend/main.py` | Import memory models, mount `/memory` router |
| `src/context/ChatContext.tsx` | Prepend system prompt, trigger extraction after response |
| `src/components/layout/AppLayout.tsx` | Route `'settings'` to `SettingsScreen` |
| `src/App.tsx` | Add `MemoryProvider` to context stack |

## Files Created

| File | Purpose |
|------|---------|
| `backend/memory/__init__.py` | Module init |
| `backend/memory/schemas.py` | Pydantic models for all three tiers |
| `backend/memory/router.py` | `/memory/*` endpoints |
| `backend/memory/extraction.py` | Unified LLM extraction (facts + entries) + secret filter |
| `backend/memory/embeddings.py` | TF-IDF + EmbeddingService |
| `backend/memory/recall.py` | Similarity search + prompt assembly from all three tiers |
| `src/types/memory.ts` | TypeScript types for all three tiers |
| `src/context/MemoryContext.tsx` | Memory React context |
| `src/components/screens/SettingsScreen.tsx` | Settings screen |
| `src/components/screens/settings/MemorySection.tsx` | Memory section container |
| `src/components/screens/settings/ContextFileCard.tsx` | Context file display card |
| `src/components/screens/settings/ContextFileEditor.tsx` | Markdown editor |
| `src/components/screens/settings/MemoryItemsList.tsx` | Learned facts list |
| `src/components/screens/settings/MemoryItemRow.tsx` | Individual learned fact |
| `src/components/screens/settings/KnowledgeEntriesList.tsx` | Knowledge entries timeline |
| `src/components/screens/settings/KnowledgeEntryRow.tsx` | Individual knowledge entry |

## Verification

1. **Context files:** Create profile/style in Settings, verify content persists across app restart.
2. **Injection:** Add "My name is Alex" to profile.md, start a new chat, ask "What's my name?" — model should know.
3. **Fact extraction:** Mention "I prefer TypeScript" in a conversation, check Settings > Learned Facts for the extracted item.
4. **Entry extraction:** Say "I ran 5K this morning in 28 minutes, felt great" in chat, check Settings > Knowledge Entries for the structured record.
5. **Recall:** In a new conversation, ask "How has my running been going?" — model should reference extracted knowledge entries.
6. **Security:** Paste an API key in chat, verify it does NOT appear in any memory tier.
7. **Deletion:** Delete a learned fact and a knowledge entry, verify neither is recalled.
8. **Graceful degradation:** Disconnect all models, verify chat still works without system prompt or extraction.
9. **Knowledge API:** Call `POST /memory/knowledge` directly with a structured entry (simulating a connector), verify it appears in the viewer and in future system prompts.
