# Cerebro Local Server: Product Requirement Document (V0)

**Product:** Cerebro (Personal Intelligence Platform)  
**Deliverable:** Cerebro Local Server (Desktop app \+ local runtime)  
**Platforms:** macOS (DMG), Windows (EXE)  
**Document scope:** User-facing functionality and system behavior for Local Server V0.

# 1\) Product definition

Cerebro is the future of personal intelligence. It acts like a **team of experts** working for you. You tell Cerebro what you want in plain English, and it **plans the work, uses your tools, double-checks results, and keeps going** until the job is done, with clear logs and approvals so you stay in control.

Cerebro Local Server is the first deliverable: an always-on desktop runtime and UI that:

* Lets you chat with Cerebro or a specific expert (in-app, and via connected channels like Telegram, WhatsApp, email, and other inbound sources via Remote Access).  
* Lets experts run routines, handle **one-off requests, and ongoing coaching** (e.g., “here’s my workout today”) and update memory/context over time.  
* Routes work in the background: an expert may **run an existing routine**, draft/create a new one for repeatable tasks, or just complete the task directly. All without the user needing to know which path happened.  
* Drafts routines for repeatable work, which you can preview, save, and assign to an expert (and then schedule from the routine settings).  
* Streams live execution logs and writes a complete run record to Activity.  
* Pauses at approval gates for sensitive actions (sending emails, meeting edits, etc).  
* Maintains scoped memory (personal / project / routine) plus per-run scratchpads.  
* Exposes all saved and installed artifacts as code (inspect/export/import).

# 2\) Problem

AI today mostly feels like a reactive chat box. You type, it replies. That is not the future we want.

* **It does not build up context about you.** Most assistants do not reliably retain and use your goals, preferences, projects, and history in a way that improves how they help over time.

* **It does not follow up on its own.** Assistants usually wait for a prompt instead of checking in after key events like meetings, workouts, or payments, when timely help matters most.  
* **It does not complete work across tools.** Real tasks live in calendar, email, docs, chat, finance, and other apps. Assistants often stop at advice, leaving the user to do the clicks and copy-paste.  
* **It is hard to trust.** A system that can act must show what it did, why it did it, and ask for approval before sensitive actions. Most assistants do not provide clear logs, history, or control.  
* **It does not adapt to different people and setups.** Users want different tools, policies, and automation styles, plus domain specialists like a coach or a personal CFO. Most assistants are not built to be extended or packaged.

**The result:** AI feels like a smarter search box and not an always-on partner that notices, remembers, and acts.

# 3\) Solution

Cerebro makes AI feel like a team of experts, not a chat box, by giving experts the ability to learn about you and take action across your tools, with logs and approvals.

* **Experts own domains.** You can talk to Cerebro or a specific expert (and expert teams). Experts handle one-off requests, ongoing coaching, and update scoped memory over time.  
* **Reliable execution across tools.** Experts can read and write through connected tools like calendar, email, docs, and chat. When work needs multiple steps or needs to be reusable, experts compile it into typed routines with explicit steps, required connections, and approval gates, then execute it through the local runtime.  
* **Works across channels and events.** You can reach Cerebro in-app and through connected channels. Work can also run from schedules and inbound events, not only from manual prompts.  
* **Trust by design.** Runs stream live logs, write a complete record to Activity, and pause for approvals before sensitive actions based on configurable policies.  
* **Extensible and inspectable.** Experts, routines, actions, templates, and capability packs are installable via the Marketplace (or user-built via chat with vibe engineering), and every artifact is viewable as code and exportable.

# 4\) Key product wedge

**Chat is the entrypoint.** Users can simply chat with Cerebro or any expert team to get help, ask questions, and log progress. Experts can update memory over time without the user creating anything.

When Cerebro detects repeatable work, it proposes saving it:

**Chat → Proposed Routine → Preview → Save Routine**

* Chat captures intent.  
* Cerebro proposes a reusable routine, not just a reply.  
* Preview runs it through the real runtime and streams live execution logs.  
* Save turns a successful preview into a persistent routine that is assigned to an expert and can be triggered later (manual, scheduled, or event-driven).

When a user wants a new specialist (expert/agent), Cerebro can vibe engineer one:

**Chat → Proposed Expert → Preview → Add Expert**

* Cerebro proposes a new expert (or team) with a clear role, tool access, and policies.  
* Preview validates behavior with real logs.  
* Add Expert installs it so it shows up in the expert tray and can be reused like any other expert.

# 5\) Core concepts and how they connect

### **5.1 Cerebro (Lead Expert)**

Cerebro is the top-level lead expert that is always available. It routes user requests, chooses the right expert(s), drafts routines and experts, and delegates execution to the runtime.

### **5.2 Experts**

An **Expert** is a specialized agent (or a team of agents) that can plan and run tasks in a domain (e.g., Executive Assistant, Personal CFO, Fitness Coach, Research Analyst).

Experts can:

* respond in chat (in-app and via connected channels)  
* handle one-off tasks and ongoing coaching  
* update scoped memory over time (preferences, progress, context)  
* run routines assigned to them  
* propose new routines (and routine updates) from user intent  
* request approvals when needed  
* explain what they did via live logs and run history

### 

### **5.3 Teams**

A Team is a group of experts with defined roles and handoffs (for example: Researcher → Analyst → Writer → Reviewer). Teams make complex work consistent by splitting it into clear stages, with each expert responsible for a slice of the outcome. Teams are packaged and installed like experts, and can be selected in chat like any other expert.

### **5.4 Routines**

A Routine is a reusable, executable playbook. Internally, a routine is a directed graph of steps with triggers. Users think of routines as outcome-driven jobs that can be simple or elaborate, for example:

* “Every weekday at 9am, prepare my plan for the day based on my calendar, todo backlog, and priorities.”  
* “After each meeting, summarize notes, extract action items, and draft follow-ups for approval.”  
* “When I log a workout, update my training plan for the rest of the week.”

Routines can be:

* scheduled (cron)  
* event-driven (webhook or inbound message)  
* manual (“Run now”)

A routine run produces a Run Record with ordered step outputs, timestamps, logs, and approval events.

A routine may specify a **default runner** (an expert or a team) for consistency and UX, but Cerebro may route or override the runner based on the user request and current context.

**Multi-Expert/Team Routine Example: “After-meeting follow-ups” (default runner: Team “Meeting Ops”)**

* **Trigger:** when a calendar event ends  
* **Researcher:** pulls the meeting doc \+ recent email thread \+ attendee context  
* **Analyst:** extracts decisions, action items, owners, deadlines  
* **Writer:** drafts follow-up email \+ action list doc  
* **Reviewer:** checks tone, missing owners, and flags anything risky  
* **Approval gate:** user approves “Send email” and “Update calendar notes”

### 

### 

### **5.5 Actions (internal building blocks)**

Actions are the internal building blocks used by experts and routines. Actions include:

* Connectors (read and write external services)  
* Channels (send and receive messages)  
* Transformers (format, map, filter)  
* Model calls  
* Expert execution steps

Actions are user-visible and usable as part of routines:

* Routine Drafts compile into an explicit Action graph.  
* Preview and Activity show Action-level execution and outputs.  
* Routine editing supports a “Show Details” view where users can inspect and adjust the Action graph (add, remove, reorder, and configure actions).  
* Code view exposes the same structure as JSON/TypeScript for export/import.

### **5.6 Connection model**

* Users interact with Cerebro in chat (in-app) and through connected channels (Telegram, WhatsApp, iMessage, Email, etc).  
* Cerebro routes requests to the appropriate expert or team.  
* Experts can respond directly, update memory, run existing routines, or propose routines for repeatable work.  
* Routines execute as a graph of Actions.  
* Marketplace distributes experts, teams, routines, templates, and action packs.  
* Remote Access routes inbound events into the local runtime, where they can trigger routines and expert work.

# 6\) Primary user flows

### **6.1 Chat with Cerebro or an expert (one-off)**

1. The user asks in Chat (with Cerebro or a selected expert).  
2. Experts respond, may take tool actions, and may update memory.  
3. If the task looks repeatable, Cerebro proposes saving it as a routine.

### **6.2 Create a routine from chat**

1. The user asks in Chat (with Cerebro or a selected expert).  
2. Cerebro returns a Routine Draft Card (including required connections and approval gates).  
3. User clicks Preview.  
4. The runtime executes the draft and streams live logs inline.  
5. User clicks Save Routine.  
6. Routine appears under Routines (toggleable, schedulable, and assigned to a default runner).

### **6.3 Run an existing routine from chat**

1. The user asks: “run my morning routine.”  
2. Cerebro matches an existing routine.  
3. The routine runs; logs stream inline and appear in Activity.

### **6.4 Approvals during a run**

1. A run reaches an approval gate.  
2. The run pauses and creates an item in Approvals.  
3. The user approves or denies.  
4. The run continues or stops; the decision is recorded in Activity.

### **6.5 Repair a failed run**

1. A run fails.  
2. Chat shows a “Fix & Retry” action.  
3. Cerebro proposes a minimal routine patch (diff).  
4. The user applies the patch and retries.

### **6.6 Install a template from Marketplace**

1. The user selects a template bundle in the Marketplace.  
2. Installs it.  
3. Template appears under Templates.  
4. The user creates a routine from the template.

### **6.7 Connect accounts and models**

1. User opens Connections.  
2. The user connects required services and enters required API keys (for example Anthropic, Gemini).  
3. The user selects model presets.  
4. Draft cards, templates, and experts reflect connection status.

# 7\) User experience (UI structure)

Cerebro is designed around two ideas:

1. **Experts are the primary surface** (you talk to a specialist, not “a workflow”).  
2. **Everything that runs is observable and controllable** (logs, approvals, history, code view).

### **7.1 Navigation (V0)**

Left nav:

* Chat  
* Experts  
* Routines  
* Activity  
* Approvals (only visible when pending)  
* Connections  
* Marketplace  
* Settings

## **7.2 Chat (primary surface)**

Chat is the main entrypoint for intent, day-to-day work, and debugging.

**Requirements**

* Default conversation is with **Cerebro (Lead Expert)**.  
* **Expert selector tray** near the top or directly above the input:  
  * shows Cerebro \+ installed experts/teams  
  * selecting an expert routes the conversation to that expert  
* Supports natural language requests and ongoing coaching (experts can update memory over time).  
* Renders **Routine Proposal Cards** inline when a request is repeatable.  
* Supports **Run Now** and **Preview** flows with **live, ordered execution logs** inline.  
* Shows **Fix & Retry** when a run fails (proposed minimal patch \+ retry). Fix & Retry should also be accessible via logs.

**Impact**

* Users don’t need to understand “automation tooling” to get value.  
* Chat produces real outcomes: saved routines, run records, approvals, and artifacts.

## **7.3 Routine Proposal Cards and Preview**

### **Routine Proposal Card (inline in Chat)**

Each card must display:

* Title  
* Plain-English steps  
* Trigger (if specified)  
* Default runner (expert/team) if specified (or easy-create a new expert for this routine).  
* Required Connections (missing connections must be clearly indicated)  
* Approval gates (what actions require approval)  
* Buttons: **Preview**, **Edit**, **Save Routine**

### **Preview (must match real execution)**

Preview executes through the same runtime path as real runs and streams events inline:

* planning  
* step started / completed  
* **Action execution \+ outputs** (connectors/channels/transformers/model calls)  
* approval requested (paused)  
* finished / failed

Preview creates a **Run Record** in Activity marked as Preview.

## **7.4 Experts**

### **Experts screen**

The Experts screen presents a clear hierarchy with Cerebro at the top.

**Cerebro (Lead Expert)**

* role: router and coordinator  
* can run any installed routine  
* can delegate to other experts/teams

**Installed Experts and Teams**  
Each expert card includes:

* name \+ domain (e.g., Executive Assistant, Personal CFO, Fitness Coach)  
* what it can do (short summary)  
* recommended routines (if available)  
* required connections (if any)  
* recent activity (last run)  
* actions: **Chat**, **Run Routine**, **Manage**  
* personality (.md file or similar that tells the expert how to be)

### **Expert management**

Experts can be:

* enabled/disabled  
* pinned (shown first in the chat tray)  
* configured with defaults (optional V0): output style, preferred channel, time window

## **7.5 Routines**

### **Routines screen**

For each routine:

* Name  
* On/Off toggle  
* Trigger summary (manual / cron / webhook)  
* Default runner (expert/team)  
* Last run status and timestamp  
* Actions: **Edit**, **Run Now**

### **Routine editing**

Routine editing must support:

* editing routine name, trigger, and approval gates  
* editing plain-English steps (Cerebro regenerates/updates the routine graph)  
* validation before saving  
* running from the editor (**Preview** or **Run Now**)

**Actions**

Actions are nodes within routines.

* The routine editor must support a **Show Details** view that exposes the underlying **Action graph** (nodes) used by the routine.  
* Users can inspect and adjust actions (add/remove/reorder/configure) in this view.  
* Code view exposes the same routine structure as JSON.

## **7.6 Activity (run history)**

### **Activity screen**

* timeline list of runs  
* filters: routine, status, date

**Run drill-down shows**

* ordered step logs and outputs  
* timestamps and durations  
* approval events  
* final outputs and artifacts  
* which expert/team executed the run  
* failures \+ error details (for Fix & Retry)

## **7.7 Approvals**

### **Approvals screen**

Approvals list items with:

* action summary  
* target(s)  
* payload preview  
* **Approve / Deny**

### **Approval behavior**

* when an approval is required, the run pauses  
* approvals are recorded in the Run Record  
* denied approvals stop the run (with a recorded reason)

## **7.8 Integrations (setup hub)**

Integrations is the single setup hub for everything that powers execution.

### **Integrations sections**

* **Accounts** (OAuth connections where supported)  
* **Keys** (API keys for model providers and services)  
* **Models** (provider \+ model presets \+ local models, probably Qwen 3.5 as default)  
* **Channels** (messaging endpoints)  
* **Connectors** (calendar, email, habit apps, finance, etc.)  
* **Remote Access** (relay status \+ webhook base URL)

Security note (UI requirement):

* wherever keys/accounts are configured, show a clear responsibility note: users should protect device access and credentials.

## **7.9 Marketplace (V0: first-party content)**

V0 Marketplace includes **only first-party packs** (no community publishing yet).

### **Marketplace items (V0)**

* **Expert packs** (experts and teams)  
* **Action packs** (connectors, channels, transformers)  
* **Template packs** (routines \+ defaults)

### **Marketplace requirements**

* browse/search  
* install/uninstall  
* updates  
* each item shows:  
  * description  
  * included experts/routines/actions  
  * required connections  
  * **Code view** (everything is inspectable)

## **8\) Remote Access (cross-network routing)**

### **8.1 Requirement**

Inbound events and remote triggers must reach the local Cerebro runtime when the user is away from home, without manual router configuration, **while preventing unauthorized access and limiting blast radius**.

### 

### 

### 

### **8.2 V0 mode: outbound relay connection (secure)**

**What the user does (authentication is “pairing”)**

1. **Turn on Remote Access**  
   1. User toggles Remote Access On in Integrations.  
   2. Cerebro shows a **Webhook Base URL** and a **Pairing Code**.

2. **Pair a channel or sender (one-time)**  
   1. Pairing is how the user proves “this Telegram account / WhatsApp number / email is mine.”

Examples:

* **Telegram / WhatsApp**  
  * The user clicks “Pair Telegram” (or “Pair WhatsApp”).  
  * Cerebro shows a short **Pairing Code**.  
  * The user sends that code to the Cerebro bot in that app.  
  * Cerebro confirms “Telegram paired” and now only that Telegram user can talk to this Cerebro.

* **Email**  
  * The user adds an email address to allow.  
  * Cerebro sends a verification email.  
  * User confirms (click link or reply with code).  
  * Only verified addresses are accepted.

* **Custom webhook sender**  
  * Cerebro generates a **Webhook Secret** (shown once).  
  * The sender must include that secret on every request (header-based).  
  * Requests without it are rejected.

3. **Use Remote Access**  
* After pairing, the user can message Cerebro through that channel, or trigger routines remotely.  
* Unpaired users get rejected automatically.

**What happens under the hood**

* Local Server keeps an **outbound connection** to the relay while the app is running.  
* External providers send events to the relay (via the Webhook Base URL).

* The relay only forwards events that are:  
  1. from a **verified provider request** (when the provider supports signing), and  
  2. from a **paired identity** (the channel account that the user verified during pairing).  
* The relay forwards the event to the local runtime over the existing outbound connection.

**Default safety policy (V0)**

Remote Access is safe by default:

* Read-only actions can run automatically.  
* Anything that sends, writes, or deletes requires **approval**.  
* Rate limits apply per user and per paired identity.

### **8.3 Remote Access UI requirements (Integrations → Remote Access)**

Must show:

* Toggle: On/Off  
* Status: Connected / Reconnecting / Offline  
* Webhook Base URL (copy button)  
* Pairing:  
  * Pairing Code (regenerate button)  
  * “Pair Telegram”, “Pair WhatsApp”, “Pair Email”, “Add Webhook Sender”  
  * Paired identities list (channel, identity, last seen)  
* Test Remote Access button that triggers a test event and creates a Run in Activity

### **8.4 Supported inbound flows**

* Inbound message/event (from a paired identity) → routine webhook trigger  
* Remote trigger endpoint (from a paired identity) → run routine

### **8.5 Offline behavior**

If Local Server is offline, inbound events may not be delivered. UI shows Offline status and last connected timestamp.

## **9\) “Everything is code” requirement**

### **9.1 Code view**

Every saved or installed artifact must provide a Code view:

* **Routines:** JSON (actions \+ triggers \+ policies \+ structured graph)  
* **Actions:** TypeScript  
* **Experts/Teams:** JSON (with playbook/instructions)

### **9.2 Export/import**

Users can export/import:

* routines  
* Experts / teams of experts  
* installed packs (where applicable)

## **10\) Memory model**

### **10.1 Memory types**

1. **Context files (user-editable, source of truth)**  
   These are plain text files that users can inspect and edit. They provide stable long-term context without relying on chat transcripts.  
   1. `memory/profile.md`  
      1. User-wide facts and preferences (goals, constraints, recurring info).

   2. `memory/style.md`  
      1. User’s communication preferences (tone, formatting, do/don’t rules).

   3. `experts/<id>/context.md`  
      1. Expert-specific context (what this expert should remember and track).

   4. `routines/<id>/context.md`  
      1. Routine-specific context (assumptions, defaults, links, notes for this routine).

   5. `teams/<id>/playbook.md`  
      1. How a team operates (roles, handoffs, quality checks, escalation rules).

2. **Semantic recall memory (mem0, auto-extracted)**  
   1. Concise memory items extracted from chats and runs (facts, preferences, recurring patterns). Stored by scope and user-manageable.

3. **Run scratchpad (ephemeral)**  
   1. Temporary working memory used during a single run (intermediate notes, tool outputs, drafts). Cleared after the run ends (except what is recorded in the Run Record for debugging).

### 

### **10.2 Initial scopes (V0)**

* **Personal (user-wide)**  
   Applies across Cerebro and all experts.

* **Expert / Team**  
   Applies only to a specific expert (or team).

* **Routine**  
   Applies only to a specific routine and its executions.

* **Run (ephemeral)**  
   Applies only to one run instance.

### **10.3 Memory behavior**

* Memory used during planning and execution must be selected by scope (Personal, Expert/Team, Routine, Run).  
* Users can view, edit, and delete **context files** from Settings.  
* Users can view and delete **semantic recall** items per scope from Settings.  
* **Vault contents and secrets (API keys, OAuth tokens, credentials) are never stored in memory** and are never written to context files.

## **11\) Cerebro (Lead Expert) requirements**

### **11.1 Always-on lead expert**

* The desktop runtime starts exactly one Cerebro lead expert at boot.  
* Cerebro is the default chat surface and the coordinator for expert work, routines, and runs.

### **11.2 Routing decisions**

For any user request, Cerebro chooses one:

* respond directly (lightweight question or guidance)  
* route the conversation to a specific expert/team  
* run an existing routine (if appropriate)  
* propose a new routine for repeatable work  
* propose a new expert/team (vibe engineered) when a new specialist is needed  
* repair a failed run (propose patch)

### 

### **11.3 Routine proposals and compilation**

* When proposing a routine, Cerebro produces a typed Routine Proposal (validated structure).  
* The proposal includes required connections, approval gates, and a default runner (expert/team) if applicable.  
* The proposal is rendered as a Routine Proposal Card.

### **11.4 Expert proposals (vibe engineering)**

* When proposing a new expert/team, Cerebro produces an Expert Proposal:

  * role \+ description  
  * tool access and policies  
  * optional personality/playbook instructions

* The proposal supports Preview and Add Expert.

### **11.5 Delegation and execution**

* Experts can respond directly and may execute actions for one-off tasks.  
* Routine execution is performed by the runtime.  
* Cerebro initiates runs, streams ordered events to the UI, and ensures all runs produce Run Records in Activity.

## **20\) Functional requirements summary (V0)**

* Chat with Cerebro \+ expert selector \+ routine draft cards  
* Preview with live inline logs  
* Save routine from preview  
* Experts screen (Cerebro at top, experts/teams beneath)  
* Routines list with toggle, trigger, edit, run now  
* Activity run history with drill-down  
* Approvals queue with approve/deny and run pause/resume  
* Integrations hub (accounts/keys/models/channels/connectors/remote access)  
* Marketplace browse/install/update  
* Code view for experts/routines/actions  
* Export/import for routines and experts  
* Memory (context files \+ scoped recall \+ run scratchpad)  
* Remote Access outbound relay \+ test

## **21\) Non-functional requirements (V0)**

* Desktop install completes and app runs without manual network configuration.  
* Local runtime supports scheduled execution while the app is running.  
* On restart, Cerebro restores routines, schedules, installed content, and run history.  
* UI remains responsive during long runs.  
* Live event stream is ordered and complete for a run.  
* Routine compilation validates before save.
