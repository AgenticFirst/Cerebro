<p align="center">
  <img src="assets/icon-rounded.png" width="128" alt="Cerebro — open source AI agent platform for desktop" />
</p>

<h1 align="center">Cerebro</h1>

<p align="center">
  <strong>Your team of AI experts.</strong>
  <br />
  Cerebro is an open-source platform for building your own team of AI experts to help run work and life.
</p>

<p align="center">
  <a href="https://github.com/AgenticFirst/Cerebro/blob/main/LICENSE"><img src="https://img.shields.io/github/license/AgenticFirst/Cerebro?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/AgenticFirst/Cerebro/stargazers"><img src="https://img.shields.io/github/stars/AgenticFirst/Cerebro?style=flat-square" alt="GitHub Stars" /></a>
  <a href="https://github.com/AgenticFirst/Cerebro/commits/main"><img src="https://img.shields.io/github/last-commit/AgenticFirst/Cerebro?style=flat-square" alt="Last Commit" /></a>
  <a href="https://github.com/AgenticFirst/Cerebro/issues"><img src="https://img.shields.io/github/issues/AgenticFirst/Cerebro?style=flat-square" alt="Open Issues" /></a>
  <a href="https://github.com/AgenticFirst/Cerebro/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome" /></a>
  <br />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-informational?style=flat-square" alt="Runs on macOS, Windows, and Linux" />
  <img src="https://img.shields.io/badge/Electron-40-47848f?style=flat-square&logo=electron" alt="Built with Electron 40" />
  <img src="https://img.shields.io/badge/TypeScript-4.5-3178c6?style=flat-square&logo=typescript" alt="Built with TypeScript" />
  <img src="https://img.shields.io/badge/Python-3.11+-3776ab?style=flat-square&logo=python" alt="Python 3.11+" />
</p>

---

## Why Cerebro?

Most AI assistants are a single chat window that forgets everything between sessions. Cerebro is a self-hosted alternative that gives you a **team of experts** (specialized AI agents) — each with persistent memory, tool access, and the ability to execute multi-step workflows — running entirely on your machine.

|  | Traditional AI assistants | Cerebro |
|---|---|---|
| **Architecture** | Single general-purpose assistant | Team of specialized experts with defined roles |
| **Memory** | Conversation-scoped, resets often | Persistent 3-tier memory scoped per user, expert, and routine |
| **Execution** | Answers and advice only | Plans, acts, and runs multi-step routines across tools |
| **Trust** | Black box | Approval gates, live execution logs, full activity history |
| **Data** | Cloud-hosted | Local-first — SQLite, on your machine, your data stays yours |

<!-- Screenshots and demo video coming soon -->

## Features

### Specialized AI Agents

Create domain-specific experts — Executive Assistant, Personal CFO, Fitness Coach, Research Analyst — each with their own memory, model selection, and tool access. Select an expert in the chat tray, or let Cerebro route automatically. Need a new specialist? Describe it in plain English and Cerebro will vibe-engineer one for you: propose, preview, install.

### Multi-Agent Orchestration

Compose teams of agents with a coordinator, role-based delegation, and sequential or parallel execution strategies. Example: a "Meeting Ops" team where Researcher pulls context, Analyst extracts action items, Writer drafts follow-ups, and Reviewer checks tone — all in one coordinated run.

### Workflow Automation from Chat

When Cerebro detects repeatable work, it proposes saving it as a reusable routine — a directed graph of steps compiled from plain English. Preview runs through the real execution engine with live streaming logs. Trigger routines on a cron schedule, via webhook, or manually.

### Autonomous Tasks

Give Cerebro a goal — a spec, an app, a research brief — and it will decompose it into phases, assign experts, execute each step, and deliver the result. Tasks support clarification questions before execution, live console output, workspace file browsing, and a final deliverable view.

### Trust by Design

Approval gates pause execution before sensitive actions (sending emails, editing calendars). Every run streams live logs to the UI and writes a complete record to Activity. Drill into any run to see step-by-step execution, timestamps, inputs, outputs, and errors.

### Long-Term Memory

Three-tier scoped memory that grows with you: **context files** (your profile, communication style, project notes), **learned facts** (auto-extracted from conversations), and **knowledge entries** (structured domain records like workouts, expenses, meetings). Memory is scoped per user, per expert, and per routine — fully viewable and editable in Settings.

### Voice Interface

Voice call mode with any expert. Local speech-to-text via faster-whisper and text-to-speech via Kokoro ONNX — no cloud transcription required. Waveform visualization, live transcript, and subtitles built in.

### Remote Chat via Telegram

Chat with Cerebro from your phone over Telegram. No public URL or tunnel needed — Cerebro long-polls the Telegram Bot API from your laptop. Bring your own bot token (nothing hard-coded in the repo), allowlist your Telegram user IDs, and you get streamed replies, voice-note transcription via the local Whisper model, inline approval buttons, and routines that DM you on completion. See [docs/telegram.md](docs/telegram.md) for the full setup guide.

## Architecture

```
Electron Main Process
├── React 19 + Tailwind CSS 4 (renderer)
├── Agent Runtime (pi-agent-core)
├── Execution Engine (DAG executor)
├── Routine Scheduler (node-cron)
├── Voice Session Manager
├── Sandbox Environment
│
└── Python / FastAPI Backend (child process)
    ├── SQLAlchemy + SQLite
    ├── Memory System (context, facts, knowledge)
    ├── Experts / Skills / Routines
    ├── Voice Engines (STT / TTS)
    └── Sandbox Enforcement
```

| Layer | Technology |
|---|---|
| Desktop shell | Electron 40 |
| Frontend | React 19, TypeScript, Tailwind CSS 4 |
| Backend | Python, FastAPI, SQLAlchemy, SQLite |
| Agent system | pi-agent-core |
| Local models | llama-cpp-python (GGUF) |
| Voice | faster-whisper (STT), Kokoro ONNX (TTS) |
| Build & test | Electron Forge, Vite, Vitest, Pytest |

## Getting Started

### Prerequisites

- **Node.js** >= 20
- **Python** >= 3.11
- **Git**
- **(macOS)** Xcode Command Line Tools — required for native modules (`node-pty`)

### Installation

```bash
# Clone the repository
git clone https://github.com/AgenticFirst/Cerebro.git
cd Cerebro

# Set up the Python backend
cd backend
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cd ..

# Install frontend dependencies
# (postinstall automatically downloads voice models ~340 MB)
npm install

# Start the app
npm start
```

On first launch, head to **Integrations** to add an API key (Anthropic, OpenAI, or Google) or download a local model to start chatting.

## Development

### Project Structure

```
Cerebro/
├── src/                  # Electron + React frontend
│   ├── agents/           # Agent runtime & tool definitions
│   ├── components/       # React UI (screens, chat, layout, experts)
│   ├── context/          # React context providers
│   ├── engine/           # DAG execution engine
│   ├── i18n/             # Internationalization (en, es)
│   ├── sandbox/          # Sandbox enforcement
│   ├── scheduler/        # Cron scheduler
│   └── voice/            # Voice session management
├── backend/              # Python FastAPI server
│   ├── experts/          # Expert CRUD
│   ├── memory/           # Memory system
│   ├── routines/         # Routine CRUD & execution
│   ├── engine/           # Backend execution engine
│   ├── skills/           # Skills system
│   ├── voice/            # STT / TTS engines
│   └── tests/            # Pytest suite
├── docs/                 # PRD, tech designs, architecture
├── scripts/              # Setup & voice model download
└── assets/               # App icons
```

### Commands

```bash
# Run all tests
npm test

# Frontend tests only
npm run test:frontend

# Backend tests only
npm run test:backend

# Lint
npm run lint

# Format
npm run format

# Package for current platform
npm run package

# Create distributable (DMG, EXE, DEB, RPM)
npm run make
```

## Roadmap

See the full [roadmap](docs/roadmap.md) for details.

- [x] App shell + chat with streaming responses
- [x] Integrations (API keys, local models, HuggingFace)
- [x] Persistent 3-tier memory system
- [x] Experts with agentic capabilities
- [x] Execution engine (DAG executor)
- [x] Routines (propose, preview, save, schedule)
- [x] Core intelligence + team orchestration
- [x] Activity + approvals
- [x] Sandbox environment
- [ ] Connectors (Google Calendar, Gmail, Notion)
- [ ] Channels (Telegram, WhatsApp, Email)
- [ ] Remote access
- [ ] Marketplace
- [ ] Onboarding tour

## Contributing

Cerebro is built in the open and we'd love your help. Whether it's a bug report, a feature idea, a docs improvement, or a pull request — every contribution matters.

**The easiest way to start is to [open an issue](https://github.com/AgenticFirst/Cerebro/issues/new).** We use issues to discuss bugs, plan features, and answer questions before any code gets written.

Ready to contribute code? See **[CONTRIBUTING.md](CONTRIBUTING.md)** for setup instructions, PR guidelines, and good first issues.

## Star History

If you find Cerebro useful, consider giving it a star. It helps others discover the project.

<p align="center">
  <a href="https://github.com/AgenticFirst/Cerebro/stargazers"><img src="https://img.shields.io/github/stars/AgenticFirst/Cerebro?style=social" alt="Star Cerebro on GitHub" /></a>
</p>

## License

MIT — see [LICENSE](LICENSE) for details.
