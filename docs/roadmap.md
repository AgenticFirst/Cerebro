# Cerebro Roadmap

> Implementation roadmap for Cerebro Local Server V0. Features are ordered by dependency and priority — the goal is to deliver a usable desktop app early and iterate.

| Task | Status |
|------|--------|
| **1. App Shell + Basic Chat** | |
| Initialize Electron + React + TypeScript project (macOS + Windows) | Done |
| Python backend with FastAPI (local API server managed by Electron) | Done |
| SQLite database and schema setup | Not Started |
| App chrome with left nav sidebar | Not Started |
| Chat UI with message input, streaming responses, and markdown rendering | Not Started |
| LLM provider integration (Cerebro lead expert) | Not Started |
| IPC bridge between renderer and main process | Not Started |
| Persistent chat history | Not Started |
| **2. Integrations** | |
| Integrations screen (Keys, Models sections) | Not Started |
| Secure credential storage (OS keychain) | Not Started |
| Model provider selection and presets (Anthropic, OpenAI, Google) | Not Started |
| Connection status indicators | Not Started |
| **3. Memory** | |
| Memory directory structure and context files (`profile.md`, `style.md`) | Not Started |
| Context file editor in Settings | Not Started |
| Inject context files into system prompts | Not Started |
| Semantic recall storage with auto-extraction from chat | Not Started |
| Memory viewer in Settings (view, search, delete by scope) | Not Started |
| **4. Experts** | |
| Expert data model and schema | Not Started |
| Experts screen (Cerebro at top, installed expert cards) | Not Started |
| Expert selector tray in Chat | Not Started |
| Expert-scoped memory and context | Not Started |
| Built-in starter experts (Executive Assistant, Fitness Coach) | Not Started |
| Expert management (enable, disable, pin) | Not Started |
| Cerebro routing logic (delegate to appropriate expert) | Not Started |
| **5. Execution Engine** | |
| Action interface (connectors, channels, transformers, model calls) | Not Started |
| DAG executor with topological ordering and event streaming | Not Started |
| Model-call and transformer action types | Not Started |
| Event streaming system (main process → renderer) | Not Started |
| Run Record persistence and state management | Not Started |
| **6. Routines** | |
| Routine data model and schema | Not Started |
| Routines screen (list, toggle, trigger summary, Run Now) | Not Started |
| Run Now with live inline logs in Chat | Not Started |
| Routine Proposal Cards in Chat (propose → preview → save) | Not Started |
| Cerebro routine proposal logic (detect repeatable intent) | Not Started |
| Preview execution with streaming logs | Not Started |
| Cron scheduler for scheduled routines | Not Started |
| **7. Activity + Approvals** | |
| Activity screen (run timeline with filters) | Not Started |
| Run drill-down view (logs, timestamps, outputs, errors) | Not Started |
| Approvals screen (pending items, approve/deny) | Not Started |
| Approval gates in execution engine (pause/resume) | Not Started |
| Approve/deny flow with run continuation or stop | Not Started |
| Approval badge in nav (visible only when pending) | Not Started |
| **8. Connectors + Channels** | |
| Connector interface and OAuth flow support | Not Started |
| Launch connectors (Google Calendar, Gmail, Notion) | Not Started |
| Connectors section in Integrations | Not Started |
| Connector actions for the execution engine | Not Started |
| Channels section in Integrations (Telegram, WhatsApp, Email) | Not Started |
| **9. Remote Access** | |
| Outbound relay client (persistent WebSocket) | Not Started |
| Remote Access UI in Integrations (toggle, status, webhook URL) | Not Started |
| Identity pairing flows (Telegram, WhatsApp, Email) | Not Started |
| Inbound event handler (validate and route) | Not Started |
| Default safety policy (read-only auto, writes need approval) | Not Started |
| Test Remote Access button | Not Started |
| **10. Marketplace** | |
| Pack format definition | Not Started |
| Marketplace screen (browse, search, detail view) | Not Started |
| Install/uninstall packs | Not Started |
| Update detection and flow | Not Started |
| First-party launch packs | Not Started |
| **11. Code View, Export/Import + Polish** | |
| Code View for all artifacts (JSON/TypeScript) | Not Started |
| Export/import for routines, experts, and packs | Not Started |
| Fix & Retry flow (propose patch, retry from failed step) | Not Started |
| Routine editor with Action graph detail view | Not Started |
| Expert/Team vibe engineering (propose → preview → add) | Not Started |
| Onboarding, notifications, and performance polish | Not Started |
