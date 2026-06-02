---
id: feature-chat-voice
name: Chat-voice sweep
scope: feature
feature: chat-voice
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
generatedAt: 2026-06-01T07:57:05.841Z
generatedBy: codex
version: 1
---

## Smoke

- [ ] Electron boots voice backend cleanly severity:P0 scope:chat-voice,smoke
  <!-- obelisk:id=01KT12ZDXH3F91NVAYQQ42W5V0 -->
  - **Expected:** App starts without uncaught renderer errors; FastAPI /health returns ok; src/main.ts passes --voice-models-dir and initializes VoiceSessionManager.
  - **Repro:** Run `tail -f /dev/null | npm start &`, wait for backend healthy, inspect logs for voice models directory and no startup exception.
- [ ] Voice tab respects beta flag severity:P0 scope:chat-voice,smoke
  <!-- obelisk:id=01KT12ZDXH2QQHK9F18T9K9RC2 -->
  - **Expected:** Settings hides Voice when `voice-calls` is off and shows Settings -> Voice when the flag is on.
  - **Repro:** Toggle `voice-calls` in feature flags, open Settings, verify the sidebar item and VoiceSection rendering.
- [ ] Expert call button is correctly gated severity:P0 scope:chat-voice,experts
  <!-- obelisk:id=01KT12ZDXHSEYXTVWGA8VBXCJS -->
  - **Expected:** Expert profiles show the call button only for enabled non-Cerebro experts when `voice-calls` is enabled.
  - **Repro:** Open an enabled expert, a disabled expert, and Cerebro profile; verify ExpertDetailPanel call button visibility.
- [ ] Voice catalog cards load severity:P0 scope:chat-voice,smoke
  <!-- obelisk:id=01KT12ZDXHEYKA777FN4AVKEYS -->
  - **Expected:** Settings -> Voice calls GET `/voice/catalog` and renders Faster Whisper Base and Kokoro 82M with install states.
  - **Repro:** Open Settings -> Voice with a stubbed backend catalog; verify STT and TTS cards, sizes, and status labels.
- [ ] Call screen loading is reachable severity:P0 scope:chat-voice,smoke
  <!-- obelisk:id=01KT12ZDXHEEXN9VFYNN3NMWVD -->
  - **Expected:** Starting a valid call navigates to CallScreen and shows initializing status messages before listening controls enable.
  - **Repro:** Mock installed catalog and successful `/conversations`, `/voice/stt/load`, `/voice/tts/load`; click expert call button.
- [ ] Missing models reach setup guidance severity:P0 scope:chat-voice,smoke
  <!-- obelisk:id=01KT12ZDXHGPKY2S2JXQ9QWQA7 -->
  - **Expected:** When models are absent, calling an expert routes to Settings -> Voice instead of failing inside STT/TTS load.
  - **Repro:** Return `/voice/catalog` with `all_installed:false`; click expert call button and verify pending voice settings section.
- [ ] Voice tests run in CI severity:P1 scope:chat-voice,smoke
  <!-- obelisk:id=01KT12ZDXH8Z99FZZK2G04TA7H -->
  - **Expected:** .github/workflows/test.yml runs frontend Vitest and backend Pytest, including backend/voice/tests/test_downloader.py.
  - **Repro:** Open a PR touching backend/voice/downloader.py and verify both CI jobs execute with no voice test skipped.
- [ ] Docs match voice install flow severity:P1 scope:chat-voice,smoke
  <!-- obelisk:id=01KT12ZDXHS4ZRRSCD21QMD4SM -->
  - **Expected:** README, CONTRIBUTING, CLAUDE, and AGENTS describe on-demand Settings voice downloads; they do not claim package postinstall downloads models.
  - **Repro:** Compare README Getting Started, package.json `postinstall:true`, VoiceSection copy, and CLAUDE/AGENTS setup guidance.

## Voice Model Setup And Validation

- [ ] Zero-byte model stays unavailable severity:P0 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXH890AS97K04D1PQ7M -->
  - **Expected:** Catalog marks a model unavailable when required check_files exist but are zero bytes.
  - **Repro:** Create empty `model.bin` or `kokoro-v1.0.onnx`; call GET `/voice/catalog` and verify `available:false`.
- [ ] Installed models report ready catalog severity:P0 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXHV1RAYW96NCE7AE4F -->
  - **Expected:** Catalog returns `all_installed:true` only when Whisper and Kokoro required files are present and non-empty.
  - **Repro:** Place non-empty check files in the expected voice-models directories; call GET `/voice/catalog`.
- [ ] Known download starts once severity:P0 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXHXSDPHBE3J18RQB7V -->
  - **Expected:** POST `/voice/download/start` with `faster-whisper-base` returns downloading and repeated starts for the same id do not duplicate work.
  - **Repro:** Call start twice before completion and inspect response state plus downloader active task count.
- [ ] Unknown download returns 404 severity:P1 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXHT174748TGA4GXMHG -->
  - **Expected:** POST `/voice/download/start` with an unknown `model_id` returns HTTP 404 and does not mutate state.json.
  - **Repro:** Send `{ "model_id": "bad-model" }` to `/voice/download/start`; compare state.json before and after.
- [ ] Second model download is rejected severity:P1 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXHKVN82YJ40ENX6D47 -->
  - **Expected:** Starting Kokoro while Whisper is downloading returns HTTP 409 with no second active download.
  - **Repro:** Mock a slow Whisper download, then POST start for `kokoro-82m`; verify 409 and unchanged active model id.
- [ ] Cancel removes partial files severity:P1 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXHDMHP6PQ4T0PSFHMM -->
  - **Expected:** Canceling a download clears `.part` files, emits `not_installed`, and catalog no longer shows downloading.
  - **Repro:** Start a model download, POST `/voice/download/cancel`, then inspect target directory and GET `/voice/catalog`.
- [ ] Failed download shows retry severity:P1 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXH8A9JNHPDVW8NZAQY -->
  - **Expected:** Network failure records `download_state:failed`, displays the error, and Retry calls startDownload with the same model id.
  - **Repro:** Stub urllib failure in downloader; open Settings -> Voice and click Retry on the failed model card.
- [ ] Stale downloading resets on restart severity:P1 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXHNG37W8922J3APBWN -->
  - **Expected:** A persisted `downloading` state from a killed process is reconciled to `not_installed` on the next catalog read.
  - **Repro:** Write state.json with `downloading`, restart backend, call GET `/voice/catalog`, and verify reset state.

## Live Calls, Failures, Persistence

- [ ] Start call creates conversation severity:P0 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXH0WMV791VQEJSDYAR -->
  - **Expected:** startCall creates a `Voice Call` conversation, loads STT/TTS, starts voice IPC, and enters listening state.
  - **Repro:** Mock `/conversations`, `/voice/stt/load`, `/voice/tts/load`, and `window.cerebro.voice.start`; click call.
- [ ] Pointer push-to-talk sends chunks severity:P0 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXHQ35DW33RE5ED2P86 -->
  - **Expected:** Mic chunks are sent only while PTT is active; pointer release calls `voice:done-speaking` once.
  - **Repro:** Hold and release CallControls mic button; spy on `sendAudioChunk` and `doneSpeaking` IPC calls.
- [ ] Space repeat does not duplicate severity:P1 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXH5G7KTBNJCJ5HDPBP -->
  - **Expected:** Holding Space starts speaking once despite key repeat; keyup sends exactly one done-speaking event.
  - **Repro:** Dispatch Space keydown, repeated keydown, and keyup on CallScreen; verify start/stop call counts.
- [ ] Short audio is ignored severity:P1 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXHMTPANVRF42EK7NES -->
  - **Expected:** Audio below `MIN_AUDIO_BYTES_FULL` returns to listening without STT call, message persistence, or error.
  - **Repro:** Call VoiceSessionManager.doneSpeaking after buffering less than 16000 bytes; inspect emitted state events.
- [ ] Partial transcript preserves response severity:P1 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXH8KHKW9SY3XBSP6WH -->
  - **Expected:** Partial transcription updates subtitles without clearing the previous expert response; final transcription clears it.
  - **Repro:** Emit `response_done`, then partial and final `transcription` events through `voice:event:<sessionId>`.
- [ ] Final turn persists messages severity:P0 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXHCA76W0FG36WGQ3J8 -->
  - **Expected:** Final user transcript and assistant response are saved to `/conversations/{id}/messages` with `metadata.type=voice_call`.
  - **Repro:** Run one mocked voice turn and inspect backend conversation messages after runner `done`.
- [ ] Voice runner forbids tools severity:P0 scope:chat-voice,experts
  <!-- obelisk:id=01KT12ZDXHA5DRBQYZS8V19R6Z -->
  - **Expected:** VoiceClaudeRunner spawns `claude -p` with the expert system prompt, max-turns 1, and disallowed Read/Write/Edit/Glob/Grep/Bash/Web tools.
  - **Repro:** Stub cached Claude path, start a voice turn, and assert spawned args include `--disallowedTools` and no `--agent`.
- [ ] Sentence streaming starts TTS early severity:P1 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXH2WC58SG3BGWP83FR -->
  - **Expected:** Complete response sentences enqueue TTS before the full Claude response is done, then remaining text is synthesized at completion.
  - **Repro:** Emit runner deltas containing two sentences; spy on POST `/voice/tts/synthesize` order and payloads.
- [ ] STT failure returns listening severity:P1 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXHEABH3EVVB967K0ZX -->
  - **Expected:** A 503 or null `/voice/stt/transcribe` result emits `Transcription failed` and returns the session to listening.
  - **Repro:** Mock STT transcribe to fail during doneSpeaking; verify error event and final state_change listening.
- [ ] TTS stream failure stays recoverable severity:P1 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXHNKX94BMTMAQ6MDTJ -->
  - **Expected:** Malformed or failed `/voice/tts/synthesize` stream shows inline callError without crashing playback or losing controls.
  - **Repro:** Return a broken SSE stream from TTS; verify CallScreen error text and enabled end-call control.
- [ ] Barge-in aborts expert speech severity:P1 scope:chat-voice
  <!-- obelisk:id=01KT12ZDXH7H8YMSY9755Q8N6B -->
  - **Expected:** Speaking during TTS aborts the current runner/TTS stream, clears queued audio, emits tts_done, and returns to listening.
  - **Repro:** Put session in speaking with active ttsAbortController, send an audio chunk, and inspect queue/state.
- [ ] End call updates memory severity:P1 scope:chat-voice,memory-knowledge
  <!-- obelisk:id=01KT12ZDXHP0NTFPZW5CA9HZ6N -->
  - **Expected:** Ending after at least one complete user/assistant turn stops capture/playback, returns to Experts, and spawns the detached memory updater without storing secrets.
  - **Repro:** Complete one mocked turn, click end call, inspect `agent-memory/<expert>` subprocess args and conversation persistence.
