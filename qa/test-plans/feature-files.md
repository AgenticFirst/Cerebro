---
id: feature-files
name: Files sweep
scope: feature
feature: files
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
  - ux-expert
generatedAt: 2026-06-04T22:04:37.044Z
generatedBy: claude
version: 1
---

## Smoke

- [ ] Files screen mounts without uncaught errors severity:P0 scope:files,smoke
  <!-- obelisk:id=01KTAANE9KY026QCJ7P43CYKC9 -->
  - **Expected:** Clicking the Files nav item renders FilesScreen; GET /files/buckets and GET /files/items/recent?limit=50 fire; no console exceptions and the header shows the Recent label.
  - **Repro:** Launch via `tail -f /dev/null | npm start &`, open DevTools console, click the Files sidebar item.
- [ ] All sidebar filters switch list query severity:P0 scope:files,smoke
  <!-- obelisk:id=01KTAANE9KYCBT165W3C881ZMP -->
  - **Expected:** Selecting Recent, Starred, Unfiled, Trash, Workspaces each updates headerLabel and fires the matching GET (e.g. starred=true, only_deleted=true, storage_kind=workspace, unfiled=true).
  - **Repro:** In FilesSidebar click each filter in turn; watch network calls and header text.
- [ ] Empty bucket shows upload empty state severity:P1 scope:files,smoke
  <!-- obelisk:id=01KTAANE9K0YMNACMQ6XP3864B -->
  - **Expected:** With zero items the body renders the FolderOpen icon, files.emptyTitle, files.emptyHint and an inline Upload button.
  - **Repro:** Open a freshly created bucket with no files.
- [ ] Loading veil shows during first fetch severity:P2 scope:files,smoke
  <!-- obelisk:id=01KTAANE9KVVMPYPRA14181BRQ -->
  - **Expected:** While isLoading is true and items is empty, the 'common.loading' veil overlays the body, then clears once items resolve.
  - **Repro:** Throttle network, navigate to Files, observe the centered loading text.

## Upload & Import

- [ ] Toolbar upload imports files into target bucket severity:P0 scope:files
  <!-- obelisk:id=01KTAANE9KMFZ3CJK7352KBKKX -->
  - **Expected:** handlePickFiles → pickFiles → uploadFiles runs importToBucket then POST /files/items per file; a 'Saved N files to Files' success toast shows and the grid refreshes.
  - **Repro:** Open a bucket, click Upload, pick 2 files in the native dialog.
- [ ] Drag-and-drop import targets active bucket severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9KWYG3D7F1T7MJ110W -->
  - **Expected:** Dragging files over the body shows the dashed accent drop overlay; dropping calls getPathForFile and uploadFiles with the active bucket (or default), then toasts success.
  - **Repro:** Drag 1+ files from Finder onto the Files body region.
- [ ] Upload before default bucket ready errors severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9K8AQFWWMF0WWJ5HKD -->
  - **Expected:** When defaultBucket is null and no bucket targeted, uploadFiles returns [] and an error toast 'Default bucket not ready yet — try again' shows; nothing is registered.
  - **Repro:** Trigger upload from Recent immediately on boot before /files/buckets resolves.
- [ ] Partial upload failure keeps successful files severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9KCJBWAZAZBCFQXY9R -->
  - **Expected:** If importOne throws for one path, a per-file 'Upload failed: <name>' error toast shows while other files still register and appear; success toast counts only the saved ones.
  - **Repro:** Upload a batch where one source path is unreadable/locked.
- [ ] POST /files/items rejects invalid source severity:P2 scope:files
  <!-- obelisk:id=01KTAANE9KNN0PMPNXGM162S70 -->
  - **Expected:** Backend create_item returns 400 'Invalid source: ...' for a source not in VALID_SOURCES; FilesContext surfaces 'Failed to register file' toast and returns null.
  - **Repro:** POST /files/items with source='bogus' against the backend.
- [ ] Cancelled file picker is a no-op severity:P2 scope:files
  <!-- obelisk:id=01KTAANE9K1Y73G7H3BTKGF5FM -->
  - **Expected:** When pickFiles returns an empty array, uploadFiles is not called, no toast appears and the list is unchanged.
  - **Repro:** Click Upload then cancel the native dialog.

## Buckets

- [ ] Create bucket with name and color severity:P0 scope:files
  <!-- obelisk:id=01KTAANE9KRATVWCT40ZKAP0TG -->
  - **Expected:** CreateBucketModal submit calls createBucket → POST /files/buckets (201); new bucket appears in sidebar and activeFilter switches to {kind:'bucket'} for the new id.
  - **Repro:** Click '+ New bucket', type 'ProjectA', pick the violet swatch, Create.
- [ ] Create disabled on blank/whitespace name severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9KH3NP3KQZMTWKD7W8 -->
  - **Expected:** The Create button stays disabled (opacity-50) while name.trim() is empty; submitting whitespace does nothing.
  - **Repro:** Open create modal, leave name empty or type spaces, observe disabled Create.
- [ ] Rename bucket via context menu prompt severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9KVSCFQ1SWD3JQ6JPS -->
  - **Expected:** Right-click a non-default bucket → Rename → window.prompt → renameBucket → PATCH /files/buckets/{id}; sidebar shows new name. Empty name yields backend 400 'Bucket name cannot be empty'.
  - **Repro:** Right-click a custom bucket, choose Rename, enter a new name then retry with blank.
- [ ] Delete bucket reassigns items then falls back severity:P0 scope:files
  <!-- obelisk:id=01KTAANE9KF63THDFBS9EA2RYA -->
  - **Expected:** AlertModal confirm → deleteBucket → DELETE /files/buckets/{id}?reassign_to=default; items move to default, bucket leaves sidebar, and active filter resets to Recent.
  - **Repro:** Right-click a custom bucket with files, Delete, confirm in the danger modal.
- [ ] Default bucket cannot be deleted severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9KTTTEYPK5MZ44KPH3 -->
  - **Expected:** Right-click on the default bucket returns early (no context menu); backend DELETE also guards with 400 'Cannot delete the Default bucket'.
  - **Repro:** Right-click the Default bucket; also call DELETE on its id directly.
- [ ] Bucket file_count excludes trashed items severity:P2 scope:files
  <!-- obelisk:id=01KTAANE9K9CWMX5KVK3E4AHWJ -->
  - **Expected:** list_buckets counts only FileItem rows with deleted_at IS NULL; soft-deleting a file decrements the bucket's displayed count.
  - **Repro:** Note a bucket count, soft-delete one of its files, reload buckets.

## Item actions

- [ ] Star toggle surfaces item under Starred severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9KXZK3NCX6VKNYJ68X -->
  - **Expected:** Context-menu Star calls starItem → PATCH {starred:true}; item shows starred and appears when the Starred filter (starred=true) is active; unstar reverses it.
  - **Repro:** Right-click a file, Star, switch to Starred filter, then unstar.
- [ ] Move selected items to another bucket severity:P0 scope:files
  <!-- obelisk:id=01KTAANE9K4E9GKJB3DX65C493 -->
  - **Expected:** MoveCopyDialog (move) → moveItems → PATCH bucket_id per id; items leave the source list, both bucket counts refresh, selection clears.
  - **Repro:** Multi-select 2 files, click Move, pick a bucket, confirm.
- [ ] Copy managed item duplicates bytes and metadata severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9KCSFEQ58MBZKN3JZ3 -->
  - **Expected:** copyItems calls files.copyManaged IPC then POST /files/items/{id}/copy; a new managed item with new storage_path appears and a 'Copied N files' toast shows.
  - **Repro:** Select a managed (uploaded) file, click Copy, choose a different bucket, confirm.
- [ ] Soft delete moves items to Trash severity:P0 scope:files
  <!-- obelisk:id=01KTAANE9K6Z3D2B49RK5X2RSG -->
  - **Expected:** softDelete → DELETE /files/items/{id} sets deleted_at; items leave the current list and appear under the Trash filter; open preview of a trashed item auto-closes.
  - **Repro:** Select files, click the red Delete action, switch to Trash.
- [ ] Restore from Trash returns item to bucket severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9KCTXV6F0PY9BQ293J -->
  - **Expected:** Trash context-menu Restore → patchItem {restore:true} clears deleted_at; item disappears from Trash and reappears in its bucket/Recent.
  - **Repro:** In Trash, right-click an item, Restore.
- [ ] Empty Trash hard-deletes and unlinks bytes severity:P0 scope:files
  <!-- obelisk:id=01KTAANE9K7JQDH8WCABMQ5PN6 -->
  - **Expected:** emptyTrash → POST /files/trash/empty returns managed paths → deleteManagedBatch unlinks them; trash list empties and a 'Trash emptied' toast shows.
  - **Repro:** With items in Trash, click Empty Trash.
- [ ] Rename item rejects blank name severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9K7CXCZJY01CCERZWP -->
  - **Expected:** Rename modal Enter/Save trims input; a blank or unchanged name is a no-op client-side, and backend update_item returns 400 'File name cannot be empty' for empty.
  - **Repro:** Right-click a file, Rename, clear the field, press Enter; then try via PATCH directly.
- [ ] Hard delete unlinks only managed paths severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9KJFE621T7MXBW6QFF -->
  - **Expected:** hardDelete issues DELETE /files/items/{id}?hard=true for all ids but only collects storagePath of storageKind==='managed' for deleteManagedBatch; workspace pointers are not unlinked from disk.
  - **Repro:** Hard-delete a mix of one managed and one workspace item from Trash.

## Workspaces & document parsing

- [ ] Workspaces filter lists task file trees severity:P1 scope:files,tasks
  <!-- obelisk:id=01KTAANE9M358M0XXSGSG4S1K8 -->
  - **Expected:** WorkspaceFilesView shows only tasks with run_id, sorted by updated/created desc; selecting one loads its tree via taskTerminal.listFiles and shows the workspace path.
  - **Repro:** Select Workspaces filter, click a completed task in the left list.
- [ ] Save workspace file into a bucket severity:P0 scope:files,tasks
  <!-- obelisk:id=01KTAANE9MW39HZKNTKSYPRFMC -->
  - **Expected:** Selecting a tree file and Save opens MoveCopyDialog (copy); confirm calls saveExternalToFiles with source 'workspace-save', importing the file and toasting 'Saved to Files → Default'.
  - **Repro:** In Workspaces, pick a task, select a file, click Save, choose a bucket, confirm.
- [ ] Workspace tree load failure degrades gracefully severity:P1 scope:files,tasks
  <!-- obelisk:id=01KTAANE9MQ7BYEK7KC3NSWBN8 -->
  - **Expected:** If listFiles/getWorkspacePath reject, loadFileTree catches, sets an empty tree and blank path, shows files.workspacesEmptyFiles and does not crash the screen.
  - **Repro:** Select a task whose workspace dir was deleted on disk.
- [ ] Parse unsupported extension returns 422 severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9MQ5XC6X1CS0V4PE4G -->
  - **Expected:** POST /files-parsing/parse on a .xyz file raises ParsingError → HTTP 422 'Unsupported file type: .xyz'; no sidecar is written.
  - **Repro:** POST /parse with file_path to an existing .xyz file.
- [ ] Parse missing file returns 404 severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9MB4XMWEHYHEPG9SBE -->
  - **Expected:** POST /files-parsing/parse with a nonexistent path returns 404 'File not found: <path>' before any extractor runs.
  - **Repro:** POST /parse with a bogus absolute path.
- [ ] Parse result cached by sha256 + parser_version severity:P2 scope:files
  <!-- obelisk:id=01KTAANE9MQ3QW9XA0HECCWK2C -->
  - **Expected:** Re-parsing the same file returns cached=true without re-running the extractor, reusing the existing .md sidecar; a deleted sidecar triggers a clean re-parse.
  - **Repro:** Call /parse twice on the same .docx; inspect the cached flag.
- [ ] Extractor timeout surfaces as 422 severity:P2 scope:files
  <!-- obelisk:id=01KTAANE9MX6CH9PMA97QQC7TW -->
  - **Expected:** An extractor exceeding PARSE_TIMEOUT_S (10s) raises ParsingError → 422 'Parsing .<ext> timed out after 10.0s'; the request does not wedge.
  - **Repro:** Feed a pathological large/complex office file that exceeds the 10s cap.
- [ ] Oversized parse truncates at 60k chars severity:P2 scope:files
  <!-- obelisk:id=01KTAANE9MTRQM2EJ9Q6CZMJJH -->
  - **Expected:** Text beyond MAX_PARSED_CHARS_PER_FILE is truncated with a '[truncated — ...]' footer; ParseResponse has truncated=true and warning='truncated'.
  - **Repro:** Parse a document whose extracted text exceeds 60,000 characters.

## Persistence & concurrency

- [ ] View mode persists across reloads severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9M0ZCS7DEF5N0FG72Z -->
  - **Expected:** Switching grid/list saves files_view_mode via saveSetting; on relaunch the FilesProvider restores the saved viewMode.
  - **Repro:** Set list view, fully restart the app, reopen Files.
- [ ] Sort key and last filter persist across reloads severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9M20HXXKD6E6S9ND6T -->
  - **Expected:** Choosing a sort (created/updated/name/opened) and a sidebar filter persist via files_sort_key and files_last_filter and are restored on next mount.
  - **Repro:** Pick 'Name' sort and the Starred filter, restart, reopen Files.
- [ ] Changing sort refetches with new order severity:P1 scope:files
  <!-- obelisk:id=01KTAANE9M8FEPGM4RBE5FPDMD -->
  - **Expected:** After the first explicit refresh, changing sortKey re-fires GET /files/items with order=<key>; list reorders accordingly (e.g. name asc, updated desc).
  - **Repro:** Open a bucket, open the sort menu, pick each order option.
- [ ] Selection clears on filter change severity:P2 scope:files
  <!-- obelisk:id=01KTAANE9MA3EJ3HY8WV19D46V -->
  - **Expected:** setActiveFilter resets selectedItemIds to empty; the move/copy/delete toolbar actions disappear when switching filters mid-selection.
  - **Repro:** Multi-select files, then click a different sidebar filter.
- [ ] Rapid multi-select move resolves consistently severity:P2 scope:files
  <!-- obelisk:id=01KTAANE9MWJFPJV310H6K55HP -->
  - **Expected:** Selecting many items and moving them issues parallel PATCHes; after Promise.all both buckets/items refresh once and no stale items remain in the source.
  - **Repro:** Cmd-click ~10 items quickly, Move, confirm, watch network + final lists.
