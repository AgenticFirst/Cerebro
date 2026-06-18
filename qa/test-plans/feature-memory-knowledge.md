---
id: feature-memory-knowledge
name: Memory-knowledge sweep
scope: feature
feature: memory-knowledge
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
  - ux-expert
generatedAt: 2026-06-04T22:02:40.094Z
generatedBy: claude
version: 1
---

## Smoke

- [ ] Knowledge Base screen boots with empty tree state severity:P0 scope:memory-knowledge,smoke
  <!-- obelisk:id=01KTAAHW2WMCGZHNZXXWBCZ0W5 -->
  - **Expected:** KnowledgeBaseScreen renders three-pane layout; with no pages, PageTreeSidebar shows emptyTreeTitle/Subtitle and a 'createFirstPage' CTA without console errors.
  - **Repro:** Launch app via `tail -f /dev/null | npm start &`, open Knowledge Base nav item on a fresh DB.
- [ ] Settings Memory section lists agent directories severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2WFJMP44GN3TVPM51W -->
  - **Expected:** SettingsScreen → Memory loads MemorySection; left pane fetches GET /agent-memory and shows agent slugs with file-count badges, or memory.noAgentsYet when none.
  - **Repro:** Open Settings → Memory; observe left directory pane.
- [ ] Backend memory/knowledge routers respond on boot severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2X772FKE7SNVWNK5AB -->
  - **Expected:** GET /knowledge/pages returns 200 KnowledgePageTreeResponse and GET /agent-memory returns 200 AgentMemoryDirsResponse once Python backend is healthy.
  - **Repro:** After backend health check passes, curl both endpoints against the random backend port.
- [ ] Ask AI button hidden until a page is open severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XYJ7R215EEYSGS3F1 -->
  - **Expected:** AskAiButton (Sparkles, bottom-right) is not rendered when no activePage; it appears only after a page is selected and panel is closed.
  - **Repro:** On empty selection, confirm no floating button; create/open a page and confirm it appears.

## Knowledge Pages CRUD & Tree

- [ ] Create root page via PAGES + button severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XXERM7AM9677QTQ0S -->
  - **Expected:** Clicking the header Plus calls createPage(null) → POST /knowledge/pages 201; new 'Untitled' node appears at root, opens in PageEditor, and tree reloads.
  - **Repro:** Click the + next to the PAGES heading in PageTreeSidebar.
- [ ] Create sub-page nests under parent and expands it severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XXK141X1FCYJEZ2F8 -->
  - **Expected:** Hover newSubpage (+) on a TreeRow → POST /knowledge/pages with parent_id; child appears under parent, parent auto-expands, sort_order = max(siblings)+1.
  - **Repro:** Hover a row, click the sub-page + action.
- [ ] Rename page persists via debounced PATCH severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XS8PWCRVW0B40Z8VG -->
  - **Expected:** Double-click title or edit PageHeader title (400ms debounce) → PATCH /knowledge/pages/{id} with title; optimistic tree update, value survives reload.
  - **Repro:** Double-click a TreeRow title, type new name, blur/Enter; reload tree.
- [ ] Editor autosaves BlockNote JSON and markdown mirror severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2X3EA35C4Y0B1J43SW -->
  - **Expected:** Typing in BlockEditor triggers savePageContent after 600ms → PATCH with content_json AND content_markdown; pending edits flush on page switch/unmount.
  - **Repro:** Open a page, type content, switch pages immediately; reopen and verify content saved.
- [ ] Set and remove page emoji icon severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2X451EGWTC9BD1YBZ6 -->
  - **Expected:** PageHeader Add Icon → EmojiPicker select sets icon via PATCH; remove icon button sets icon null; tree row icon updates optimistically.
  - **Repro:** Hover header, click addIcon, pick emoji, then reopen picker and click removeIcon.
- [ ] Apply cover URL and remove cover banner severity:P2 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2X7DHW6MDTF1EDF8QC -->
  - **Expected:** CoverUrlPopover Apply trims whitespace and calls setPageCover → PATCH cover_url; CoverBanner renders image; Remove Cover sets cover_url null and hides banner.
  - **Repro:** Header addCover → enter https URL → Apply; then hover banner → removeCover.
- [ ] Create page under missing parent returns 404 severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2X3Q6SDFEJ74YEJ01D -->
  - **Expected:** POST /knowledge/pages with non-existent parent_id returns 404 'Parent page not found'; no orphan row created.
  - **Repro:** curl POST /knowledge/pages with parent_id of a deleted/unknown id.

## Page Search

- [ ] Search returns FTS hits with highlighted snippet severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XK1XMWSVMRCERAKKX -->
  - **Expected:** Typing in search box (200ms debounce) → GET /knowledge/search?q=; SearchResults shows hits, snippet sentinels \x01/\x02 render as highlighted <mark> spans, title weighted 10x.
  - **Repro:** Create pages with known body text, type a matching term in the sidebar search.
- [ ] Empty/whitespace query returns no API call and no results severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XWK41Q216X1AB00X2 -->
  - **Expected:** Blank or whitespace-only query short-circuits to [] without hitting /knowledge/search; SearchResults not shown.
  - **Repro:** Type spaces into search box, then clear; observe no network request.
- [ ] Special-character query does not error severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XDXQQJ83MFYT9AEKW -->
  - **Expected:** GET /knowledge/search?q=50%25 extracts alphanumeric tokens ('50'); returns 200 results without FTS syntax error.
  - **Repro:** Search '50%' and 'a*b'; verify 200 response, not 500.
- [ ] Search falls back to ilike when FTS5 unavailable severity:P2 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2X9TNM0QD7NTF1Q1A8 -->
  - **Expected:** With KNOWLEDGE_FTS_AVAILABLE false, /knowledge/search uses escaped ilike (% and _ escaped) and still returns matching pages.
  - **Repro:** Run backend without FTS5 support; issue a search and confirm matches return.
- [ ] Clicking a search hit opens that page and clears search severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XSG48SEDA5EXFDH9E -->
  - **Expected:** Clicking a SearchResults row calls onOpen(id) → GET /knowledge/pages/{id}, page loads in editor, and the search query/results reset.
  - **Repro:** Search, click a hit, confirm editor loads it and the list closes.
- [ ] Escape key clears active search query severity:P2 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XWRQF8FC0V7B0NT1M -->
  - **Expected:** Pressing Escape in the search input empties the query and dismisses SearchResults, returning to the tree view.
  - **Repro:** Type a query, press Escape.

## Drag-and-Drop Tree

- [ ] Drop inside a row reparents as last child severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XV4NFAKAV88WV7GDE -->
  - **Expected:** Dragging to the middle 50% (position 'inside') shows ring indicator and computeDropTarget returns parentId=target, sortOrder=lastChild+1; movePage → POST /knowledge/pages/reorder.
  - **Repro:** Drag a node onto the center of another row, release.
- [ ] Drop before/after reorders siblings with float midpoint severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XX1JQM7EA4NQKS31B -->
  - **Expected:** Top 25% ('before') and bottom 25% ('after') show line indicator; computeDropTarget assigns midpoint sortOrder between neighbors; order persists after reload.
  - **Repro:** Drag a node to the top edge of a sibling, then bottom edge; reload tree.
- [ ] Cannot drop a node into its own subtree severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2X963V7F41EYEMAANJ -->
  - **Expected:** isDescendant guard makes computeDropTarget return null for a node dropped onto its descendant; no reorder request fires.
  - **Repro:** Expand a parent and drag it onto one of its own children.
- [ ] Self-drop is rejected severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XPQX1S8YAYRM8E5KC -->
  - **Expected:** Dragging a node onto itself returns null from computeDropTarget; tree unchanged, no POST /reorder.
  - **Repro:** Begin drag and release on the same row.
- [ ] Backend rejects move into self with 400 severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2X4NE3BCC3C5BTX5F0 -->
  - **Expected:** PATCH /knowledge/pages/{id} with parent_id=child id returns 400 'Cannot move a page into itself'; descendant cycle guard enforced server-side.
  - **Repro:** curl PATCH setting a parent's parent_id to its own descendant.

## Ask AI Threads

- [ ] Open Ask AI panel anchored to current page severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XZ74VR9XRATXZNG7F -->
  - **Expected:** AskAiButton → openForPage loads GET /knowledge/ai/threads?page_id=; panel expands to 400px with composer and empty-thread state.
  - **Repro:** Open a page, click the Sparkles button.
- [ ] Sending first message lazily creates a thread severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XCET3ZQRKDHHHBVT9 -->
  - **Expected:** send() with no thread creates thread (title from first question, max 60 chars) via POST /knowledge/ai/threads, then POST messages; user bubble + streaming assistant render.
  - **Repro:** Type a question in Ask AI composer, press Enter.
- [ ] Web search badge toggles during tool use severity:P1 scope:memory-knowledge,chat-voice
  <!-- obelisk:id=01KTAAHW2XD948PJRTHDATHKJG -->
  - **Expected:** On tool_start for WebSearch/WebFetch the askAiSearchingWeb badge (Globe) shows searching=true; tool_end clears it; thinking Loader2 shows before any text.
  - **Repro:** Ask a question that triggers web search; watch streaming indicators.
- [ ] Send button disabled on empty input and while running severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XT40GSBQSYHKWV34D -->
  - **Expected:** Send button (Send icon) is disabled when input is empty or isRunning true (shows Loader2); enabled only with trimmed text and idle run.
  - **Repro:** Observe button with empty composer, then during an in-flight run.
- [ ] Switch and delete threads from dropdown severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XPV4JZ4D31R27YGKG -->
  - **Expected:** Thread switcher lists threads; openThread loads its messages via GET messages; trash icon calls removeThread → DELETE thread (cascades messages); list refreshes.
  - **Repro:** Create two threads, switch between them, delete one via hover trash.
- [ ] Create thread for missing page returns 404 severity:P2 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XT4WPQTCBDTFBPHHX -->
  - **Expected:** POST /knowledge/ai/threads with non-existent page_id returns 404 'Page not found'; no thread row persisted.
  - **Repro:** curl POST /knowledge/ai/threads with an invalid page_id.
- [ ] Run survives panel collapse and page switch severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XE55D84R7VTF1VGDY -->
  - **Expected:** An in-flight assistant run continues streaming (event subscription by runId) when the panel collapses to 44px or the user switches pages; collapsed Sparkles pulses.
  - **Repro:** Start a long answer, collapse the panel and switch pages mid-stream.

## Agent Memory Files

- [ ] Create new .md file auto-appending extension severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2X8Z920KY8RQSX9XVK -->
  - **Expected:** MemorySection New File input creates file on Enter; missing extension gets '.md' appended → PUT /agent-memory/{slug}/files/{path} 200; file list and directory count refresh.
  - **Repro:** Select an agent, click +, type 'notes', press Enter.
- [ ] Edit and save file content; Save disabled when clean severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XW46Q2V39778YD211 -->
  - **Expected:** Editing textarea sets isDirty; Save (PUT) enabled only when content !== original; after save original updates and button disables.
  - **Repro:** Select a file, edit text, Save; confirm button greys out after.
- [ ] Delete file clears selection and refreshes list severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XF956S9JFE5YTM061 -->
  - **Expected:** Delete button → DELETE /agent-memory/{slug}/files/{path} 204; editor clears to empty state, file removed from list, directory count decrements.
  - **Repro:** Select a file, click Delete (red).
- [ ] Reject non-.md file write with 400 severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2X7X373NGGD8R0X75H -->
  - **Expected:** PUT /agent-memory/{slug}/files/notes.txt returns 400 'Only .md files are allowed'; no file written.
  - **Repro:** curl PUT with a .txt path and content body.
- [ ] Path traversal attempt is rejected severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XTGVNPYP7NRMXHEM9 -->
  - **Expected:** GET/PUT with encoded '..' (e.g. %2E%2E/etc/passwd) or '/' returns 400 'Invalid path'/'Invalid slug' via _safe_join; no filesystem escape.
  - **Repro:** curl GET /agent-memory/test/files/%2E%2E/%2E%2E/etc/passwd.
- [ ] Delete of nonexistent file is idempotent severity:P2 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XSRK6W6MT66ZAQDQQ -->
  - **Expected:** DELETE of a missing file returns 204 with no error; GET of a nonexistent directory returns 200 with empty files list.
  - **Repro:** curl DELETE a ghost.md path and GET an unknown slug's files.

## Trash & Persistence

- [ ] Move page to trash archives it and descendants severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2X037P6T5C42EASMR8 -->
  - **Expected:** Context menu Move to Trash → archivePage PATCH is_archived=true cascades to all descendants; page leaves tree, active selection clears, tree reloads.
  - **Repro:** Right-click (⋮) a parent with children, choose Move to Trash.
- [ ] Restore page from Trash modal severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XK302ZS3R81VJSCX9 -->
  - **Expected:** TrashModal lists archived pages (GET /knowledge/trash); Restore → PATCH is_archived=false; page reappears in tree and list refreshes.
  - **Repro:** Open Trash footer, click Restore on an item.
- [ ] Permanently delete cascades children and threads severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XGQSYJ7CC77TH5592 -->
  - **Expected:** TrashModal Delete Permanently → DELETE /knowledge/pages/{id} 204; descendants, ai_threads and ai_messages removed via FK cascade; item gone from trash.
  - **Repro:** In Trash, click Delete Permanently on a page that had children/threads.
- [ ] Tree, content and icons persist across reload severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XHBG5ZQC8ZMR83RR8 -->
  - **Expected:** After creating pages, editing content, setting icons, restarting the app reloads identical tree via GET /knowledge/pages and page content via GET /knowledge/pages/{id}.
  - **Repro:** Build a small tree, quit and relaunch Cerebro, reopen Knowledge Base.
- [ ] Legacy memory context files remain readable severity:P2 scope:memory-knowledge
  <!-- obelisk:id=01KTAAHW2XE9WAYT7Q34FFQ42R -->
  - **Expected:** GET /memory/context-files returns ContextFileResponse[] (key/content/updated_at) for 'memory:context:'-prefixed settings rows; legacy-items endpoint returns extraction rows.
  - **Repro:** curl GET /memory/context-files and /memory/legacy-items on a DB with seeded context.
