---
id: feature-tasks
name: Tasks sweep
scope: feature
feature: tasks
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
generatedAt: 2026-06-01T08:02:45.347Z
generatedBy: codex
version: 1
---

## Smoke

- [ ] Tasks board boots cleanly severity:P0 scope:tasks,smoke
  <!-- obelisk:id=01KT139SF3EQSMQZZRPJDZTPWA -->
  - **Expected:** The Tasks screen renders Backlog, In Progress, To Review, Completed, and Error columns with no uncaught renderer errors.
  - **Repro:** Run npm start, open Tasks, watch console while GET /tasks and GET /tasks/stats complete.
- [ ] Empty board remains usable severity:P0 scope:tasks,smoke
  <!-- obelisk:id=01KT139SF3YW3GGXNE8F3JEHAM -->
  - **Expected:** Empty columns show their all-clear state, Add Card buttons work, and the New Task button opens the modal.
  - **Repro:** Use a fresh SQLite profile, open Tasks, inspect all five empty columns, click New Task and each column Add Card.
- [ ] Task API mounts at boot severity:P0 scope:tasks,smoke
  <!-- obelisk:id=01KT139SF37RZZTA45SQV1SQW4 -->
  - **Expected:** GET /tasks returns a list and GET /tasks/stats returns all five count keys without 404s.
  - **Repro:** After backend boot, call GET /tasks and GET /tasks/stats through window.cerebro.invoke or API client.
- [ ] Tasks loading failure is contained severity:P1 scope:tasks,smoke
  <!-- obelisk:id=01KT139SF38Z4Y0BN6G5MM18BY -->
  - **Expected:** A failed /tasks or /tasks/stats request stops loading and does not crash navigation or other screens.
  - **Repro:** Temporarily stop the backend or mock one endpoint to 500, then open Tasks and navigate away/back.
- [ ] Task test scripts are reachable severity:P1 scope:tasks,smoke
  <!-- obelisk:id=01KT139SF3FP8BQR9KTJQ0T8MK -->
  - **Expected:** The package test commands include frontend and backend execution paths needed to run task coverage.
  - **Repro:** Run npm run test:frontend for src/pty/TaskPtyRunner.test.ts and npm run test:backend for backend task routes.

## Task Board CRUD

- [ ] Create dialog saves full task severity:P0 scope:tasks
  <!-- obelisk:id=01KT139SF3VDB7RMGMWJPSAAY4 -->
  - **Expected:** Submitting title, description, expert, priority, dates, and project folder creates a Backlog card with matching persisted fields.
  - **Repro:** Click New Task, fill Title, Description, Expert, Priority, Start date, Due date, Project Folder, submit, then GET /tasks/{id}.
- [ ] Blank title cannot submit severity:P0 scope:tasks
  <!-- obelisk:id=01KT139SF3KJRZVP7P6QEQWE7P -->
  - **Expected:** Create Task stays disabled for whitespace-only titles and no POST /tasks request is sent.
  - **Repro:** Open New Task, type spaces in the title input, leave description filled, and try clicking Create Task.
- [ ] Column quick-add trims title severity:P1 scope:tasks
  <!-- obelisk:id=01KT139SF3X9H8774MHCFT838E -->
  - **Expected:** Inline Add Card creates a task in that column using the trimmed title and closes without creating empty cards.
  - **Repro:** Click Add Card in To Review, enter '  Draft QA plan  ', press Enter, then verify POST /tasks body column=to_review.
- [ ] Invalid backend fields reject severity:P0 scope:tasks
  <!-- obelisk:id=01KT139SF3YMAXCDJ1FE8GRK17 -->
  - **Expected:** Invalid column, invalid priority, and overlong checklist body return 400/422 and leave existing task state unchanged.
  - **Repro:** Call POST /tasks with column='bad', PATCH /tasks/{id} priority='critical', and POST /checklist with 501 chars.
- [ ] Drawer metadata edits persist severity:P0 scope:tasks
  <!-- obelisk:id=01KT139SF3MXXD37DW2EX8PAQZ -->
  - **Expected:** Title, description markdown, expert, priority, start_at, due_at, and project_path edits survive closing and reopening the drawer.
  - **Repro:** Open a card, edit each metadata control, close drawer, reload Tasks, reopen the same card, and compare GET /tasks/{id}.
- [ ] Tags normalize and filter severity:P1 scope:tasks
  <!-- obelisk:id=01KT139SF3JTT058EVHKSBQACD -->
  - **Expected:** Tags lowercase, hyphenate spaces, dedupe, reject >32 characters, and board filters only matching cards.
  - **Repro:** In drawer Tags, add 'Sales Ops', duplicate it, and a 33-character tag, then click the generated sales-ops filter chip.
- [ ] Drag reorder preserves positions severity:P0 scope:tasks
  <!-- obelisk:id=01KT139SF3ASKBH52YRM5WHJRG -->
  - **Expected:** Dragging cards computes float positions between neighbors and reloads in the same order after refresh.
  - **Repro:** Create three Backlog cards, drag the third between first and second, inspect POST /tasks/{id}/move position, then reload.
- [ ] Checklist item promotes once severity:P1 scope:tasks
  <!-- obelisk:id=01KT139SF3Y3YHTSQ8SA77QTMF -->
  - **Expected:** Promoting a checklist item creates one child task, marks the item linked, and a second promote returns an error.
  - **Repro:** Add a checklist item, click Promote, verify child parent_task_id, then call POST /checklist/{item_id}/promote again.

## Execution Files Persistence

- [ ] Assigned task starts expert run severity:P0 scope:tasks,experts
  <!-- obelisk:id=01KT139SF3SNTVAMDCS9WZCEX6 -->
  - **Expected:** Start moves the card to In Progress, creates a RunRecord, sets run_id, opens Console, and streams PTY output.
  - **Repro:** Assign an enabled expert, click Start Task, verify POST /tasks/{id}/run-event type=run_started and Console has runId.
- [ ] Unassigned task cannot start severity:P0 scope:tasks,experts
  <!-- obelisk:id=01KT139SF30CPEQP2VSS953NX4 -->
  - **Expected:** Start is disabled or shows the start-needs-expert toast, and no agent.run call is made.
  - **Repro:** Create an unassigned Backlog card, inspect its Start button and drag it into In Progress.
- [ ] Completion stores deliverable preview severity:P0 scope:tasks
  <!-- obelisk:id=01KT139SF37RJ2CSRDASWPFRME -->
  - **Expected:** run_completed moves task to To Review, sets completed_at, persists result_md/title/kind, and Preview opens by default.
  - **Repro:** Mock an agent done event with a parsed deliverable, then reopen the task drawer and GET /tasks/{id}.
- [ ] Run failure reaches error column severity:P0 scope:tasks
  <!-- obelisk:id=01KT139SF3G1VS7YYA82R2T0ZH -->
  - **Expected:** run_failed moves the task to Error, persists last_error, updates RunRecord failed, and Activity shows failure text.
  - **Repro:** Mock window.cerebro.agent.onEvent error or POST /tasks/{id}/run-event type=run_failed with error='boom'.
- [ ] Cancel discards queued instruction severity:P0 scope:tasks
  <!-- obelisk:id=01KT139SF3KHJT0W298S96W556 -->
  - **Expected:** Cancel kills the active run, moves task to Backlog, clears run_id, and changes pending queued comments to discarded.
  - **Repro:** Start a task, send an instruction while running, click Cancel Task, then GET /tasks/{id}/comments.
- [ ] Only one instruction queues severity:P1 scope:tasks
  <!-- obelisk:id=01KT139SF3KF2AW1JPE5D6W32V -->
  - **Expected:** A running task accepts one pending instruction, disables Send to Expert, and rejects a second queued instruction with 409.
  - **Repro:** While task is in_progress with run_id, submit one instruction, then directly POST another with queue_status='pending'.
- [ ] Attachments materialize idempotently severity:P1 scope:tasks,files
  <!-- obelisk:id=01KT139SF3E9X6WGVS92V9YRQA -->
  - **Expected:** Duplicate file bytes dedupe at registration, materialize copies once, skips matching files, and suffixes filename collisions.
  - **Repro:** Attach the same file twice, POST /attachments/materialize twice, then place different bytes at attachments/name.ext and retry.
- [ ] Workspace state survives reload severity:P0 scope:tasks
  <!-- obelisk:id=01KT139SF3EKBDTS5KBAYHCR0Y -->
  - **Expected:** Tasks, comments, checklist counts, tags, attachments, workspace_dir, deliverable preview, and terminal buffer replay after app restart.
  - **Repro:** Create and run a task with comments/checklist/files, quit Cerebro, restart, open Tasks, Console, Preview, and Files tabs.
