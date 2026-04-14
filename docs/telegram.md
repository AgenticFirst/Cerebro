# Telegram Bridge

Chat with Cerebro from your phone via Telegram.

## Why Telegram?

Cerebro's backend is localhost-only — it never opens a port to the public internet. Most messaging bridges (WhatsApp Cloud API, Slack bots, Discord) require a public HTTPS webhook, which means you'd need ngrok or a similar tunnel.

Telegram supports **long polling**: Cerebro *calls out* to Telegram's servers to ask for new messages. No inbound port, no tunnel, no router changes. You just need the token from @BotFather.

Because the token is per-user (each person sets up their own bot), nothing is hard-coded in Cerebro's source.

## What works

- Plain chat from your phone, with streamed replies.
- Image / document / voice-note / audio attachments. Voice notes are transcribed by Cerebro's local Whisper model.
- `/expert` command to pick which expert handles the conversation.
- Tool approvals: when Cerebro asks for approval mid-run, you get inline **Approve ✓ / Deny ✗** buttons on your phone.
- Routines can DM you when they complete or fail.

## Security model (read this)

- **Only allowlisted Telegram user IDs can chat with the bot.** Anyone else gets one rate-limited reply telling them their numeric ID so the operator can add them.
- The bridge **only runs while Cerebro is open**. Close the app and the bot goes dormant — messages queue at Telegram and are delivered when you reopen.
- **Telegram bot traffic is not end-to-end encrypted.** Telegram servers see messages. For true E2E, use Signal (not supported here yet). For most "summarize my day, run this tool, check approvals" use, Telegram is fine.
- **The bot token is stored in Cerebro's local SQLite database in plaintext.** This is a known gap shared with every other credential Cerebro stores today and will move to OS keychain in a later change. Keep your machine secure; if the token leaks, revoke it with `@BotFather` → `/revoke`.

## Setup

### 1. Create your Telegram bot

1. Open Telegram → message **@BotFather** → send `/newbot`.
2. Send a **display name** (e.g. `My Cerebro`).
3. Send a **username** ending in `bot` (e.g. `my_cerebro_bot`).
4. @BotFather replies with a token like `123456789:AAH…`. Copy it.

> **Don't share this token.** Anyone who has it can send messages as your bot and read what people send to it.

### 2. Connect it to Cerebro

1. In Cerebro → **Integrations** → **Channels** → find the **Telegram** section at the top.
2. Paste the token → **Verify**. You should see `@your_bot_name ✓`.

### 3. Discover your Telegram user ID

1. Open Telegram → search for your bot by username → **Start** → send any message.
2. The bot replies: `Not authorized. Your Telegram user ID is <number>.`
3. Copy the number.

### 4. Allow yourself

1. Back in Cerebro → paste the number into **Allowed user IDs**. Separate multiple IDs with commas.
2. (Optional) Toggle **Forward all approvals to Telegram** if you want desktop-initiated approvals to reach your phone too.
3. Click **Save**, then flip **Enable bridge** on.

### 5. Chat

From your phone, DM the bot. Cerebro replies.

## Commands

| Command | What it does |
|---|---|
| `/help` | Show this list |
| `/expert list` | List available experts |
| `/expert <slug>` | Switch the expert for this chat |
| `/expert clear` | Reset to default |
| `/reset` | Start a fresh conversation |

## Approvals on phone

When a tool needs approval, the bot sends a message with **Approve ✓ / Deny ✗** buttons. Tap one; the message updates and the run continues.

By default you only see approvals from runs you started on your phone. Turn on **Forward all approvals** if you want desktop-initiated approvals too.

## Routines → Telegram

A routine can DM you automatically.

### Option A: notify on completion

Open the routine in the editor. In the toolbar, click **Notify on completion**, tick the recipients. When the routine finishes or fails, each recipient gets a message.

### Option B: send mid-run

Add a `channel` action as a step in the routine DAG. Set `channel: telegram`, `operation: send`, `recipients: ["123456789"]`, `message: "whatever you want"`. Useful when a routine finds something worth flagging before the full run ends.

**Safety limits on proactive messages:**
- Every recipient must be in the allowlist.
- 30 proactive messages per hour per recipient. Excess is dropped (to prevent a runaway routine nuking your phone).
- Message text is scrubbed of bot tokens, dataDir file paths, and API-key-looking strings before sending.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Verify" fails | Token is wrong, has a trailing space, or no internet. |
| Bot doesn't reply | Check **Enable bridge** is on, your user ID is in the allowlist, and Cerebro is running. |
| Bot stopped responding | Cerebro closed. Reopen — the bridge restarts automatically if it was enabled. |
| "Rate limit exceeded" | You hit 20 messages/minute. Wait a minute. |
| "Queue full" | A previous message is still being processed. Wait for it to finish. |
| Token leaked | @BotFather → `/revoke` → generate a new one → paste into Cerebro → click Verify → Save. |

## What it doesn't do (yet)

- No group chats, channels, or inline mode — DMs only.
- No proactive push outside of routine completions and approvals.
- No background daemon — the bridge is tied to Cerebro's desktop process.
- No end-to-end encryption.
- Missed scheduled routines during sleep do not fire retroactively.
