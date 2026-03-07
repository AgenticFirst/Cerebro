# Actions Tech Design — Routine Canvas

> **Status**: Draft
> **Depends on**: [Routines](routines.md), [Execution Engine](execution-engine.md), [Experts](experts-agentic-system.md), [Memory](memory-system.md)

## Problem

The Routine Canvas is functional but unintuitive. Users coming from n8n or Langflow expect categorized nodes, visual triggers on the canvas, typed connections, and concrete integration nodes (e.g., "Gmail", "Strava", "WhatsApp") — not abstract types like `model_call` or `connector`. The current `NodePalette` is a 180px popup with 4 generic action types. This redesign makes the canvas match modern workflow builders while leveraging Cerebro's unique strengths (Experts, Memory, Cloud Providers).

---

## 1. Action Category Taxonomy

6 categories modeled after n8n and Langflow, adapted for Cerebro's AI-agent identity.

### Category 1: Triggers (teal `#14b8a6`, icon: `Zap`)

Triggers become the **first node on the canvas** (like n8n). One trigger per routine. Cannot be deleted.

| Action | Name | Key Config Fields | Output Data |
|--------|------|-------------------|-------------|
| `trigger_schedule` | Schedule | days (M-Su checkboxes), time (HH:MM picker), timezone | `{ triggered_at, schedule_description }` |
| `trigger_manual` | Manual | _(none — just a "Run Now" button)_ | `{ triggered_at, triggered_by }` |
| `trigger_webhook` | Webhook | path (auto-generated URL), secret (optional auth token) | `{ payload, headers, method }` |
| `trigger_app_event` | App Event | app (dropdown: Gmail, Strava, Calendar...), event | Service-specific payload |

### Category 2: AI (violet `#8b5cf6`, icon: `Brain`)

These nodes use Cerebro's existing cloud providers or local models.

| Action | Name | Key Config Fields | What It Does |
|--------|------|-------------------|-------------|
| `ask_ai` | Ask AI | prompt, model, system prompt, temperature, max tokens | Single LLM call |
| `run_expert` | Run Expert | expert, task, context, max turns | Delegates to a Cerebro Expert |
| `classify` | Classify | prompt, categories (label+description pairs), model | AI picks one category from a list |
| `extract` | Extract | prompt, schema (field name + type + description), model | Pulls structured data from unstructured text |
| `summarize` | Summarize | input_field, max_length (short/medium/long), focus, model | Condenses long text |

### Category 3: Knowledge (indigo `#6366f1`, icon: `BookOpen`)

These nodes tap into Cerebro's memory system, web search, and (future) document RAG.

| Action | Name | Key Config Fields | What It Does |
|--------|------|-------------------|-------------|
| `search_memory` | Search Memory | query, scope, max results | Queries Cerebro's memory system |
| `search_web` | Search Web | query, max_results, include_ai_answer | Calls Tavily API |
| `search_documents` | Search Documents | query, collection, top_k, similarity_threshold | RAG retrieval (future) |
| `save_to_memory` | Save to Memory | content, scope, type | Persists information to memory |

### Category 4: Integrations (blue `#3b82f6`, icon: `Plug2`)

Each integration is a **specific node** — not a generic "connector" with a dropdown.

| Action | Name | Key Config Fields | Status |
|--------|------|-------------------|--------|
| `http_request` | HTTP Request | method, URL, headers, body, auth, timeout | Available |
| `integration_google_calendar` | Google Calendar | action, calendar, date range, query filter | Coming Soon |
| `integration_gmail` | Gmail | action, search filter, to/subject/body | Coming Soon |
| `integration_slack` | Slack | action, channel, message text | Coming Soon |
| `integration_whatsapp` | WhatsApp | action, to, message text, type | Coming Soon |
| `integration_github` | GitHub | action, repo, filters | Coming Soon |
| `integration_strava` | Strava | action, activity_id, data to fetch | Coming Soon |
| `integration_notion` | Notion | action, database ID, filters | Coming Soon |

The HTTP Request node is the universal fallback — any API without a dedicated node can be called via HTTP Request.

### Category 5: Logic (slate `#64748b`, icon: `GitBranch`)

| Action | Name | Key Config Fields | What It Does |
|--------|------|-------------------|-------------|
| `condition` | Condition | field, operator, value | If/else branching. Two output handles: True and False |
| `loop` | Loop | items_field, variable_name | Iterates over a list |
| `delay` | Delay | duration, unit | Pauses execution |
| `approval_gate` | Approval Gate | summary, timeout | Pauses for human review (already implemented) |
| `merge` | Merge | strategy, match_field | Combines outputs from parallel branches |

### Category 6: Output (emerald `#10b981`, icon: `ArrowUpRight`)

| Action | Name | Key Config Fields | What It Does |
|--------|------|-------------------|-------------|
| `send_message` | Send Message | message, target | Posts a message in Cerebro's chat |
| `send_notification` | Notification | title, body, urgency | Desktop notification via Electron |
| `send_email` | Send Email | to, subject, body, provider | Sends email via configured provider |
| `webhook_response` | Webhook Response | status_code, body, headers | Returns data to webhook caller |

---

## 2. Worked Example: Strava Running Coach Pipeline

**Intent**: "After every Strava run, analyze my performance against my training plan and send me a WhatsApp message with coaching advice."

```
[Webhook Trigger]  →  [Search Memory]  →  [Run Expert]  →  [Send Message]
  POST /webhook/       "training plan       Running Coach     WhatsApp via
  strava-activity       this week"          + activity data    HTTP Request
                       Scope: Running       + training plan
                       Coach
```

**Data flow:**
1. **Webhook Trigger** receives Strava POST → `{ payload: { distance, pace, duration, heart_rate_avg, ... } }`
2. **Search Memory** queries "training plan this week" scoped to Running Coach → `{ results: [{ content: "Week 12: Easy 10K Mon..." }] }`
3. **Run Expert** delegates to Running Coach with Strava data + memory results → detailed coaching advice
4. **Send Message** via HTTP Request to WhatsApp Business API with expert's response

---

## 3. Worked Example: Morning Briefing Pipeline

**Intent**: "Every weekday at 9 AM, gather my calendar events and unread emails, create an agenda, and notify me."

```
[Schedule]  →  [Google Calendar]  ─┐
 Weekdays      Get Events Today    ├→  [Ask AI]  →  [Notification]
 9:00 AM    →  [Gmail]           ─┘    "Create       "Your Daily
               Get Unread Emails        briefing"     Briefing"
```

Schedule trigger fans out to two integration nodes (Calendar + Gmail) in parallel, then AI summarizes.

---

## 4. Worked Example: Email Auto-Responder with Approval

```
[App Event: Gmail]  →  [Classify]  →  [Condition]
 New Email              urgent/         If urgent? ──┐
                        action/                      │
                        fyi/spam     ┌── False ──┐   └── True ──┐
                                     ▼            │              ▼
                                 [Ask AI]         │          [Ask AI]
                                 "Auto-ack"       │          "Draft reply"
                                     │            │              │
                                     ▼            │              ▼
                                 [Send Email]     │      [Approval Gate]
                                 auto-ack reply   │       "Review draft"
                                                  │              │ (approved)
                                                  │              ▼
                                                  │      [Send Email]
                                                  │       AI draft reply
```

---

## 5. Action Sidebar (replaces NodePalette)

320px right-side sliding panel. Replaces the current 180px bottom-left popup.

**Structure:**
- Header: "Add Node" title with close button
- Search input filtering across all categories by name, description, keywords
- 6 collapsible category groups, each with colored header icon
- Each action item shows icon, name, and description
- "soon" badge on unavailable actions — visible but not draggable

**Interaction:**
- Open via `+` button (bottom-left) or keyboard shortcut `A`
- Drag-and-drop OR click-to-add (adds at viewport center)
- Mutually exclusive with StepConfigPanel (selecting a node closes sidebar; opening sidebar deselects node)

---

## 6. Sticky Notes

Annotation nodes on the canvas.

- Warm semi-transparent yellow background
- No handles — cannot connect to other nodes
- Editable text (double-click to edit inline)
- Resizable via drag handle
- Keyboard shortcut: `Shift+N`
- NOT part of the DAG — filtered out during serialization
- Persisted in `annotations[]` alongside steps in `dag_json`

---

## 7. Node Visual Differentiation

Each category gets a distinct left border + background tint:

| Category | Left Border | Background | Selected Glow |
|----------|------------|------------|---------------|
| Triggers | 4px teal `#14b8a6` | `teal-500/5` | teal glow |
| AI | 4px violet `#8b5cf6` | `violet-500/5` | violet glow |
| Knowledge | 4px indigo `#6366f1` | `indigo-500/5` | indigo glow |
| Integrations | 4px blue `#3b82f6` | `blue-500/5` | blue glow |
| Logic | 4px slate `#64748b` | `slate-400/5` | slate glow |
| Output | 4px emerald `#10b981` | `emerald-500/5` | emerald glow |

Trigger nodes: 260px wide, special layout (shows schedule/URL prominently).
Condition nodes: Two output handles (True/False) instead of one.
All other nodes: 200px wide, standard layout.

---

## 8. Data References Between Nodes (Variable System)

`{{step_name.field}}` syntax in prompt and text fields:

| Expression | Meaning |
|-----------|---------|
| `{{trigger.payload}}` | The trigger node's output |
| `{{trigger.payload.distance}}` | A specific field from the trigger payload |
| `{{search_memory.results}}` | The Search Memory node's results array |
| `{{classify.category}}` | The Classify node's chosen category |
| `{{ask_ai.response}}` | The Ask AI node's text response |
| `{{run_expert.response}}` | The Run Expert node's text response |
| `{{http_request.body}}` | The HTTP Request node's response body |

Config panels show autocomplete when typing `{{` — listing available upstream node outputs.

---

## 9. Connection Handle Types (Visual Only in V1)

Edges color-coded by source node's output type:

| Handle Type | Color | Source Nodes |
|------------|-------|-------------|
| `message` | Violet `#8b5cf6` | Ask AI, Run Expert, Summarize |
| `data` | Amber `#f59e0b` | Extract, HTTP Request, Search Memory, Search Web, integrations |
| `category` | Indigo `#6366f1` | Classify |
| `signal` | Slate `#64748b` | Condition, Loop, Delay, Approval Gate, triggers |

No type enforcement in V1 — any output can connect to any input. Colors are purely visual.

---

## 10. Serialization and Backward Compatibility

`dag_json` evolves from `{ steps: [...] }` to:

```typescript
interface CanvasDefinition {
  steps: StepDefinition[];            // Same as before
  trigger?: TriggerNodeData;          // NEW — trigger node position + config
  annotations?: AnnotationNodeData[]; // NEW — sticky notes
  canvasViewport?: {                  // NEW
    x: number;
    y: number;
    zoom: number;
  };
}
```

All new fields are optional. Old `dag_json` values parse correctly. When opening a routine with old-format `dag_json`, the canvas auto-creates a trigger node from the routine's `trigger_type` field.

---

## 11. Mapping Old Action Types to New

| Old `actionType` | New `actionType` | Category | Notes |
|-----------------|-----------------|----------|-------|
| `model_call` | `ask_ai` | AI | Renamed for clarity |
| `expert_step` | `run_expert` | AI | Renamed for clarity |
| `transformer` | `transform` | Logic | Renamed |
| `connector` | `http_request` | Integrations | Generic → specific |
| `channel` | `send_message` | Output | Renamed for clarity |
| `approval_gate` | `approval_gate` | Logic | Unchanged |

Migration handled transparently in `dagToFlow()`. Old `actionType` values in existing DAGs are mapped to new names on load.

---

## 12. Changes to Existing Routines Tech Design

1. **Reference**: "See `actions.md` for the complete action type taxonomy, canvas UX, and sidebar design."
2. **Updated DAG JSON format**: `CanvasDefinition` as new serialization format (backward-compatible superset).
3. **Trigger-on-canvas**: Triggers represented as canvas nodes. `trigger_type` and `cron_expression` on Routine model remain source of truth, synced bidirectionally.
4. **Variable system**: `{{step_name.field}}` expression syntax.

---

## 13. Files Modified

| File | Change |
|------|--------|
| `src/utils/step-defaults.ts` | `ActionCategory` + `ACTION_CATEGORIES`. New `ActionMeta` fields. All new action types. Old type migration map. |
| `src/utils/dag-flow-mapping.ts` | `CanvasDefinition` type. Trigger node + annotation serialization. Old actionType migration. |
| `src/hooks/useRoutineCanvas.ts` | Trigger node state, sidebar state, sticky note CRUD, category-colored edges. |
| `src/components/screens/routines/RoutineEditor.tsx` | Replace NodePalette → ActionSidebar. Register new node types. Keyboard shortcuts (`A`, `Shift+N`). |
| `src/components/screens/routines/RoutineStepNode.tsx` | Category-aware styling (left border, bg tint, selected glow). Handle colors. |
| `src/components/screens/routines/StepConfigPanel.tsx` | Config forms for all new action types. |
| `src/components/screens/routines/EditorToolbar.tsx` | Trigger pill reads from canvas trigger node. |

## 14. Files Created

| File | Purpose |
|------|---------|
| `docs/tech-designs/actions.md` | This tech design document |
| `src/components/screens/routines/ActionSidebar.tsx` | Main sidebar (320px, categories, search) |
| `src/components/screens/routines/ActionSidebarItem.tsx` | Draggable item in sidebar |
| `src/components/screens/routines/ActionCategoryGroup.tsx` | Collapsible category section |
| `src/components/screens/routines/TriggerNode.tsx` | ReactFlow node for triggers |
| `src/components/screens/routines/TriggerConfigPanel.tsx` | Config panel for trigger nodes |
| `src/components/screens/routines/StickyNoteNode.tsx` | Annotation node |
| `src/utils/handle-types.ts` | Handle type → color registry |

## 15. Files Removed

| File | Reason |
|------|--------|
| `src/components/screens/routines/NodePalette.tsx` | Replaced by ActionSidebar |

---

## 16. Implementation Phases

| Phase | Scope | Size |
|-------|-------|------|
| **A** | Category registry + updated ACTION_META with new action types + migration map | Small |
| **B** | Action Sidebar (replaces NodePalette) with search + categories | Medium |
| **C** | Node visual differentiation (left border, bg tint, handle colors) | Small |
| **D** | Trigger nodes on canvas + TriggerConfigPanel + bidirectional sync | Medium |
| **E** | Sticky notes (StickyNoteNode + Shift+N shortcut) | Small |
| **F** | Variable system (`{{step.field}}` autocomplete in config panels) | Medium |
| **G** | New AI action implementations (Classify, Extract, Summarize) | Medium |
| **H** | New Logic implementations (Condition w/ dual handles, Loop, Delay, Merge) | Medium |
| **I** | HTTP Request action implementation | Medium |
| **J** | Knowledge actions (Search Memory, Search Web, Save to Memory) | Medium |
| **K** | Integration node framework + first integration | Large |
