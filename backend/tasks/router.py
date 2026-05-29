import asyncio
import json
import logging
import os
import shutil
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from models import Expert, FileItem, RunRecord, Setting, Task, TaskChecklistItem, TaskComment
from sandbox.validation import cerebro_data_dir, validate_link_path

logger = logging.getLogger(__name__)

from .schemas import (
    ChecklistItemCreate,
    ChecklistItemRead,
    ChecklistItemUpdate,
    CommentCreate,
    CommentQueueUpdate,
    CommentRead,
    TaskAttachmentCreate,
    TaskAttachmentMaterializeError,
    TaskAttachmentMaterializeRequest,
    TaskAttachmentMaterializeResult,
    TaskAttachmentRead,
    TaskCreate,
    TaskMove,
    TaskRead,
    TaskReconcileRequest,
    TaskStats,
    TaskUpdate,
)
from .slug import build_workspace_dir

router = APIRouter()

VALID_COLUMNS = {"backlog", "in_progress", "to_review", "completed", "error"}
VALID_PRIORITIES = {"low", "normal", "high", "urgent"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _validate_project_path(raw: str, request: Request) -> str:
    result = validate_link_path(raw, cerebro_data_dir(request))
    if not result.ok:
        raise HTTPException(400, result.reason or "Invalid project_path")
    return result.canonical


def _parse_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return value if isinstance(value, list) else []


def _serialize_tags(tags: list[str] | None) -> str | None:
    if not tags:
        return None
    seen: set[str] = set()
    unique: list[str] = []
    for tag in tags:
        if not isinstance(tag, str):
            continue
        cleaned = tag.strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            unique.append(cleaned)
    return json.dumps(unique) if unique else None


def _ensure_workspace_dir(task: Task, db: Session) -> str:
    """Backfill workspace_dir for legacy rows on read so the renderer can
    always rely on the field being populated."""
    if task.workspace_dir:
        return task.workspace_dir
    task.workspace_dir = build_workspace_dir(task.title, task.id)
    db.add(task)
    db.commit()
    return task.workspace_dir


def _task_to_read(task: Task, db: Session) -> TaskRead:
    workspace_dir = _ensure_workspace_dir(task, db)
    checklist_items = (
        db.query(TaskChecklistItem)
        .filter(TaskChecklistItem.task_id == task.id)
        .order_by(TaskChecklistItem.position)
        .all()
    )
    comment_count = (
        db.query(func.count(TaskComment.id))
        .filter(TaskComment.task_id == task.id)
        .scalar()
    )
    total = len(checklist_items)
    done = sum(1 for item in checklist_items if item.is_done)

    return TaskRead(
        id=task.id,
        title=task.title,
        description_md=task.description_md,
        column=task.column,
        expert_id=task.expert_id,
        parent_task_id=task.parent_task_id,
        priority=task.priority,
        start_at=task.start_at,
        due_at=task.due_at,
        position=task.position,
        run_id=task.run_id,
        last_error=task.last_error,
        project_path=task.project_path,
        workspace_dir=workspace_dir,
        tags=_parse_tags(task.tags),
        result_md=task.result_md,
        result_title=task.result_title,
        result_kind=task.result_kind,
        created_at=task.created_at,
        updated_at=task.updated_at,
        started_at=task.started_at,
        completed_at=task.completed_at,
        checklist=[ChecklistItemRead.model_validate(i) for i in checklist_items],
        comment_count=comment_count or 0,
        checklist_total=total,
        checklist_done=done,
    )


def _add_system_comment(db: Session, task_id: str, body: str) -> None:
    db.add(TaskComment(
        task_id=task_id,
        kind="system",
        author_kind="system",
        body_md=body,
    ))


# ── Task CRUD ──

@router.post("", response_model=TaskRead)
def create_task(body: TaskCreate, request: Request, db: Session = Depends(get_db)):
    if body.column not in VALID_COLUMNS:
        raise HTTPException(400, f"Invalid column: {body.column}")
    if body.priority not in VALID_PRIORITIES:
        raise HTTPException(400, f"Invalid priority: {body.priority}")

    project_path = None
    if body.project_path and body.project_path.strip():
        project_path = _validate_project_path(body.project_path, request)

    max_pos = (
        db.query(func.max(Task.position))
        .filter(Task.column == body.column)
        .scalar()
    ) or 0.0

    task = Task(
        title=body.title,
        description_md=body.description_md,
        column=body.column,
        expert_id=body.expert_id,
        parent_task_id=body.parent_task_id,
        priority=body.priority,
        start_at=body.start_at,
        due_at=body.due_at,
        position=max_pos + 1024.0,
        project_path=project_path,
        tags=_serialize_tags(body.tags),
    )
    db.add(task)
    db.flush()
    task.workspace_dir = build_workspace_dir(task.title, task.id)
    _add_system_comment(db, task.id, "Task created")
    db.commit()
    db.refresh(task)
    return _task_to_read(task, db)


@router.get("", response_model=list[TaskRead])
def list_tasks(
    column: str | None = None,
    expert_id: str | None = None,
    parent_task_id: str | None = None,
    db: Session = Depends(get_db),
):
    q = db.query(Task)
    if column:
        q = q.filter(Task.column == column)
    if expert_id:
        q = q.filter(Task.expert_id == expert_id)
    if parent_task_id is not None:
        q = q.filter(Task.parent_task_id == parent_task_id)
    return [_task_to_read(t, db) for t in q.order_by(Task.position).all()]


@router.get("/stats", response_model=TaskStats)
def task_stats(db: Session = Depends(get_db)):
    rows = (
        db.query(Task.column, func.count(Task.id))
        .group_by(Task.column)
        .all()
    )
    counts = {col: cnt for col, cnt in rows}
    return TaskStats(
        backlog=counts.get("backlog", 0),
        in_progress=counts.get("in_progress", 0),
        to_review=counts.get("to_review", 0),
        completed=counts.get("completed", 0),
        error=counts.get("error", 0),
    )


@router.get("/{task_id}", response_model=TaskRead)
def get_task(task_id: str, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return _task_to_read(task, db)


@router.patch("/{task_id}", response_model=TaskRead)
def update_task(task_id: str, body: TaskUpdate, request: Request, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")

    updates = body.model_dump(exclude_unset=True)
    if "priority" in updates and updates["priority"] not in VALID_PRIORITIES:
        raise HTTPException(400, f"Invalid priority: {updates['priority']}")

    if "project_path" in updates:
        raw = updates["project_path"]
        updates["project_path"] = (
            _validate_project_path(raw, request) if raw and raw.strip() else None
        )

    if "tags" in updates:
        updates["tags"] = _serialize_tags(updates["tags"])

    old_expert_id = task.expert_id
    reassigned = "expert_id" in updates and updates["expert_id"] != old_expert_id

    for key, val in updates.items():
        setattr(task, key, val)

    if reassigned:
        new_expert_id = updates["expert_id"]
        if new_expert_id:
            new_expert = db.get(Expert, new_expert_id)
            new_name = new_expert.name if new_expert else "another expert"
        else:
            new_name = "Unassigned"
        _add_system_comment(db, task.id, f"Reassigned to {new_name}")

    db.commit()
    db.refresh(task)
    return _task_to_read(task, db)


@router.post("/{task_id}/move", response_model=TaskRead)
def move_task(task_id: str, body: TaskMove, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    if body.column not in VALID_COLUMNS:
        raise HTTPException(400, f"Invalid column: {body.column}")

    old_column = task.column
    task.column = body.column

    if body.position is not None:
        task.position = body.position
    else:
        max_pos = (
            db.query(func.max(Task.position))
            .filter(Task.column == body.column, Task.id != task_id)
            .scalar()
        ) or 0.0
        task.position = max_pos + 1024.0

    if body.column == "in_progress" and old_column != "in_progress":
        task.started_at = task.started_at or _utcnow()
    elif body.column == "completed" and old_column != "completed":
        task.completed_at = _utcnow()

    if old_column != body.column:
        label = body.column.replace("_", " ").title()
        _add_system_comment(db, task.id, f"Moved to {label}")

    db.commit()
    db.refresh(task)
    return _task_to_read(task, db)


@router.delete("/{task_id}")
def delete_task(task_id: str, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    db.delete(task)
    db.commit()
    return {"ok": True}


@router.post("/{task_id}/cancel", response_model=TaskRead)
def cancel_task(task_id: str, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    task.column = "backlog"
    task.run_id = None
    # A pending queued instruction must not quietly drain into a future run
    # of the same task after cancellation — drop it here.
    db.query(TaskComment).filter(
        TaskComment.task_id == task_id,
        TaskComment.queue_status == "pending",
    ).update({TaskComment.queue_status: "discarded"})
    _add_system_comment(db, task.id, "Task cancelled, moved back to Backlog")
    db.commit()
    db.refresh(task)
    return _task_to_read(task, db)


# ── Run event callback (called by Electron main process) ──

TERMINAL_EVENTS = {"run_completed", "run_failed", "run_cancelled"}

# Sales Intel Analyst expert — fires GHL contact sync on task completion.
SALES_INTEL_ANALYST_ID = "91be7fc45ee045aca27e7ffb28103900"


async def _push_to_ghl(db: Session, task: Task) -> None:
    """Push a completed intel brief to GoHighLevel as a contact + note.

    All exceptions are caught and logged. A GHL failure must never propagate
    up and disrupt the task-completion flow.
    """
    try:
        from integrations.ghl import GHLClient

        api_key_row = db.get(Setting, "ghl_api_key")
        location_id_row = db.get(Setting, "ghl_location_id")

        if not api_key_row or not location_id_row:
            logger.debug("GHL push skipped — credentials not configured")
            return

        client = GHLClient(
            api_key=api_key_row.value,
            location_id=location_id_row.value,
        )
        await client.push_intel_brief(
            task_title=task.title,
            brief_md=task.description_md or "",
        )
        logger.info("GHL push complete for task %s (%r)", task.id, task.title)
    except Exception:
        logger.exception("GHL push failed for task %s — continuing", task.id)


@router.post("/{task_id}/run-event")
async def handle_run_event(task_id: str, event: dict, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")

    event_type = event.get("type")
    run_id = event.get("run_id")

    if event_type == "run_started":
        # Ensure a RunRecord exists for this run_id — tasks.run_id has a FK to it.
        # The Electron runtime mints the runId but doesn't create the DB row for
        # task runs, so we create it here on first sight.
        if run_id and not db.get(RunRecord, run_id):
            db.add(RunRecord(
                id=run_id,
                expert_id=task.expert_id,
                status="running",
                run_type="task",
                trigger="manual",
                started_at=_utcnow(),
            ))
            db.flush()
        task.column = "in_progress"
        task.run_id = run_id
        task.started_at = task.started_at or _utcnow()
        # Clear any previous deliverable — the new run will write a fresh one.
        task.result_md = None
        task.result_title = None
        task.result_kind = None
        _add_system_comment(db, task.id, "Expert started working")
    elif event_type in TERMINAL_EVENTS:
        # Ignore events from a stale run. After cancel/re-run the task's
        # run_id points at the new run; a late event carrying the old run_id
        # must not stomp the current state.
        if run_id and task.run_id and task.run_id != run_id:
            return {"ok": True, "ignored": "stale_run_id"}
        # Ignore terminal events when the task has already reached a terminal
        # column. Stops `error → to_review` resurrections and makes repeated
        # `run_completed` events idempotent (no duplicate system comments).
        if task.column in ("to_review", "completed", "error"):
            return {"ok": True, "ignored": "already_terminal"}

        if event_type == "run_completed":
            task.column = "to_review"
            task.completed_at = _utcnow()
            # Persist the parsed <deliverable> block so Vista previa can render
            # the result without re-reading the PTY buffer. The runtime sends
            # these on every successful task run (parseDeliverableBlock); they
            # may be absent for very old clients.
            result_md = event.get("result_md")
            result_title = event.get("result_title")
            result_kind = event.get("result_kind")
            if isinstance(result_md, str) and result_md.strip():
                task.result_md = result_md
                task.result_title = result_title if isinstance(result_title, str) else None
                task.result_kind = result_kind if isinstance(result_kind, str) else None
            if run_id:
                run = db.get(RunRecord, run_id)
                if run:
                    run.status = "completed"
                    run.completed_at = _utcnow()
            _add_system_comment(db, task.id, "Expert finished — ready for review")
            # Fire GHL integration for the Sales Intel Analyst expert.
            if task.expert_id == SALES_INTEL_ANALYST_ID:
                asyncio.create_task(_push_to_ghl(db, task))
        elif event_type == "run_failed":
            task.column = "error"
            task.last_error = event.get("error", "Unknown error")
            if run_id:
                run = db.get(RunRecord, run_id)
                if run:
                    run.status = "failed"
                    run.error = task.last_error
                    run.completed_at = _utcnow()
            _add_system_comment(db, task.id, f"Expert run failed: {task.last_error}")
        elif event_type == "run_cancelled":
            task.column = "error"
            task.last_error = "Run was cancelled"
            if run_id:
                run = db.get(RunRecord, run_id)
                if run:
                    run.status = "cancelled"
                    run.completed_at = _utcnow()
            _add_system_comment(db, task.id, "Expert run cancelled")
    else:
        raise HTTPException(400, f"Invalid run-event type: {event_type!r}")

    db.commit()
    db.refresh(task)
    return {"ok": True}


# ── Reconciler (live orphan recovery, polled from Electron main) ──

@router.post("/reconcile")
def reconcile_tasks(body: TaskReconcileRequest, db: Session = Depends(get_db)):
    """Reconcile in_progress tasks whose run is no longer alive in the runtime.

    The Electron AgentRuntime posts its set of currently-live run IDs on a
    periodic tick. Any task still pinned to in_progress whose run is NOT in
    that set is orphaned — the PTY exited but the renderer's run-event POST
    (normally driven by the 'done'/'error' IPC listener in TaskContext) never
    landed. We sync the task's column with its linked RunRecord status, or
    mark the run as failed if the runtime dropped it without persisting a
    terminal state.
    """
    live_run_ids = set(body.live_run_ids)
    now = _utcnow()

    orphans = (
        db.query(Task)
        .filter(Task.column == "in_progress")
        .filter(Task.run_id.isnot(None))
        .all()
    )
    candidate_run_ids = [t.run_id for t in orphans if t.run_id not in live_run_ids]
    runs_by_id: dict[str, RunRecord] = {
        r.id: r for r in db.query(RunRecord).filter(RunRecord.id.in_(candidate_run_ids)).all()
    } if candidate_run_ids else {}

    reconciled = 0
    for task in orphans:
        if task.run_id in live_run_ids:
            continue

        run = runs_by_id.get(task.run_id)
        run_status = run.status if run else None

        if run_status == "completed":
            task.column = "to_review"
            task.completed_at = now
            _add_system_comment(db, task.id, "Reconciled — run completed but event was dropped.")
        elif run_status in ("failed", "cancelled"):
            task.column = "error"
            task.last_error = (run.error if run and run.error else "Run ended without a final event.")
            task.completed_at = now
            _add_system_comment(db, task.id, f"Reconciled — run {run_status} but event was dropped.")
        else:
            # Runtime has dropped the run (not live) but the RunRecord still
            # says running/paused/None. Mark as failed — there is no live
            # subprocess to produce a deliverable.
            task.column = "error"
            task.last_error = "Reconciled — no live subprocess for this run."
            task.completed_at = now
            if run and run.status in ("running", "paused", None):
                run.status = "failed"
                run.error = "Orphaned — no live subprocess"
                run.completed_at = now
            _add_system_comment(db, task.id, "Reconciled — subprocess no longer alive.")

        reconciled += 1

    if reconciled:
        db.commit()

    return {"reconciled": reconciled}


# ── Comments ──

@router.post("/{task_id}/comments", response_model=CommentRead)
def create_comment(task_id: str, body: CommentCreate, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    if body.kind not in ("comment", "instruction"):
        raise HTTPException(400, f"Invalid comment kind: {body.kind}")

    queue_status = body.queue_status
    pending_expert_id = body.pending_expert_id
    if queue_status is not None:
        if queue_status != "pending":
            raise HTTPException(400, f"Invalid queue_status on create: {queue_status}")
        if body.kind != "instruction":
            raise HTTPException(400, "Only instruction comments can be queued")
        if task.column != "in_progress" or not task.run_id:
            raise HTTPException(400, "Can only queue while a run is in progress")
        existing = (
            db.query(TaskComment)
            .filter_by(task_id=task_id, queue_status="pending")
            .first()
        )
        if existing:
            raise HTTPException(409, "A queued instruction already exists for this task")
        if pending_expert_id and not db.get(Expert, pending_expert_id):
            raise HTTPException(400, f"Expert {pending_expert_id} not found")
    else:
        # Only allow queue fields paired with queue_status=pending.
        pending_expert_id = None

    comment = TaskComment(
        task_id=task_id,
        kind=body.kind,
        author_kind="user",
        body_md=body.body_md,
        queue_status=queue_status,
        pending_expert_id=pending_expert_id,
    )
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return CommentRead.model_validate(comment)


@router.patch("/{task_id}/comments/{comment_id}/queue-status", response_model=CommentRead)
def update_comment_queue_status(
    task_id: str,
    comment_id: str,
    body: CommentQueueUpdate,
    db: Session = Depends(get_db),
):
    comment = db.get(TaskComment, comment_id)
    if not comment or comment.task_id != task_id:
        raise HTTPException(404, "Comment not found")
    if comment.queue_status != "pending":
        raise HTTPException(400, f"Comment is not pending (current: {comment.queue_status})")
    if body.queue_status not in ("delivered", "discarded"):
        raise HTTPException(400, f"Invalid target queue_status: {body.queue_status}")
    comment.queue_status = body.queue_status
    db.commit()
    db.refresh(comment)
    return CommentRead.model_validate(comment)


@router.get("/{task_id}/comments", response_model=list[CommentRead])
def list_comments(task_id: str, db: Session = Depends(get_db)):
    comments = (
        db.query(TaskComment)
        .filter(TaskComment.task_id == task_id)
        .order_by(TaskComment.created_at)
        .all()
    )
    return [CommentRead.model_validate(c) for c in comments]


# ── Checklist ──

@router.post("/{task_id}/checklist", response_model=ChecklistItemRead)
def create_checklist_item(
    task_id: str, body: ChecklistItemCreate, db: Session = Depends(get_db)
):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")

    max_pos = (
        db.query(func.max(TaskChecklistItem.position))
        .filter(TaskChecklistItem.task_id == task_id)
        .scalar()
    ) or 0.0

    item = TaskChecklistItem(
        task_id=task_id,
        body=body.body,
        position=max_pos + 1024.0,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return ChecklistItemRead.model_validate(item)


@router.patch("/{task_id}/checklist/{item_id}", response_model=ChecklistItemRead)
def update_checklist_item(
    task_id: str,
    item_id: str,
    body: ChecklistItemUpdate,
    db: Session = Depends(get_db),
):
    item = db.get(TaskChecklistItem, item_id)
    if not item or item.task_id != task_id:
        raise HTTPException(404, "Checklist item not found")

    updates = body.model_dump(exclude_unset=True)
    for key, val in updates.items():
        setattr(item, key, val)
    db.commit()
    db.refresh(item)
    return ChecklistItemRead.model_validate(item)


@router.post("/{task_id}/checklist/{item_id}/promote", response_model=TaskRead)
def promote_checklist_item(
    task_id: str,
    item_id: str,
    db: Session = Depends(get_db),
):
    item = db.get(TaskChecklistItem, item_id)
    if not item or item.task_id != task_id:
        raise HTTPException(404, "Checklist item not found")
    if item.promoted_task_id:
        raise HTTPException(400, "Item already promoted")

    parent = db.get(Task, task_id)
    if not parent:
        raise HTTPException(404, "Task not found")

    max_pos = (
        db.query(func.max(Task.position))
        .filter(Task.column == parent.column)
        .scalar()
    ) or 0.0

    child = Task(
        title=item.body,
        column=parent.column,
        expert_id=parent.expert_id,
        parent_task_id=task_id,
        priority=parent.priority,
        position=max_pos + 1024.0,
    )
    db.add(child)
    db.flush()

    item.promoted_task_id = child.id
    _add_system_comment(task_id=task_id, db=db, body=f"Promoted \"{item.body}\" to card")
    _add_system_comment(task_id=child.id, db=db, body="Created from parent checklist item")

    db.commit()
    db.refresh(child)
    return _task_to_read(child, db)


@router.delete("/{task_id}/checklist/{item_id}")
def delete_checklist_item(
    task_id: str, item_id: str, db: Session = Depends(get_db)
):
    item = db.get(TaskChecklistItem, item_id)
    if not item or item.task_id != task_id:
        raise HTTPException(404, "Checklist item not found")
    db.delete(item)
    db.commit()
    return {"ok": True}


# ── Attachments ──

def _attachment_to_read(item: FileItem) -> TaskAttachmentRead:
    return TaskAttachmentRead(
        id=item.id,
        task_id=item.source_task_id or "",
        name=item.name,
        ext=item.ext,
        mime=item.mime,
        size_bytes=item.size_bytes,
        storage_kind=item.storage_kind,
        storage_path=item.storage_path,
        sha256=item.sha256,
        created_at=item.created_at,
    )


@router.post("/{task_id}/attachments", response_model=TaskAttachmentRead, status_code=201)
def create_attachment(
    task_id: str,
    body: TaskAttachmentCreate,
    db: Session = Depends(get_db),
):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")

    # De-dup: same task + same bytes → return existing row.
    existing = (
        db.query(FileItem)
        .filter(
            FileItem.source == "task-attachment",
            FileItem.source_task_id == task_id,
            FileItem.sha256 == body.sha256,
            FileItem.deleted_at.is_(None),
        )
        .first()
    )
    if existing is not None:
        return _attachment_to_read(existing)

    item = FileItem(
        bucket_id=None,
        name=body.name,
        ext=(body.ext or "").lower().lstrip("."),
        mime=body.mime,
        size_bytes=body.size_bytes,
        sha256=body.sha256,
        storage_kind="managed",
        storage_path=body.storage_path,
        source="task-attachment",
        source_task_id=task_id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return _attachment_to_read(item)


@router.get("/{task_id}/attachments", response_model=list[TaskAttachmentRead])
def list_attachments(task_id: str, db: Session = Depends(get_db)):
    if not db.get(Task, task_id):
        raise HTTPException(404, "Task not found")
    items = (
        db.query(FileItem)
        .filter(
            FileItem.source == "task-attachment",
            FileItem.source_task_id == task_id,
            FileItem.deleted_at.is_(None),
        )
        .order_by(FileItem.created_at)
        .all()
    )
    return [_attachment_to_read(i) for i in items]


@router.delete("/{task_id}/attachments/{file_id}", status_code=204)
def delete_attachment(
    task_id: str,
    file_id: str,
    hard: bool = Query(False),
    db: Session = Depends(get_db),
):
    item = db.get(FileItem, file_id)
    if not item or item.source_task_id != task_id or item.source != "task-attachment":
        raise HTTPException(404, "Attachment not found")
    # Caller (Electron renderer) is responsible for unlinking the bytes
    # via FILES_DELETE_MANAGED IPC once this returns.
    if hard:
        db.delete(item)
    else:
        item.deleted_at = _utcnow()
    db.commit()
    return Response(status_code=204)


def _sha256_of(path: str) -> str | None:
    import hashlib
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _unique_dest(dest_dir: str, name: str) -> str:
    """Return a path under dest_dir for `name` that doesn't already exist.
    On collision, suffixes ' (1)', ' (2)', ... before the extension."""
    candidate = os.path.join(dest_dir, name)
    if not os.path.exists(candidate):
        return candidate
    stem, ext = os.path.splitext(name)
    counter = 1
    while True:
        candidate = os.path.join(dest_dir, f"{stem} ({counter}){ext}")
        if not os.path.exists(candidate):
            return candidate
        counter += 1


@router.post(
    "/{task_id}/attachments/materialize",
    response_model=TaskAttachmentMaterializeResult,
)
def materialize_attachments(
    task_id: str,
    body: TaskAttachmentMaterializeRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Copy every live task-attachment for this task into <cwd>/attachments/.

    Idempotent: if a destination file already exists with the matching sha256,
    it's reported as ``skipped`` and not overwritten. Different bytes under
    the same filename get a `` (1)``/`` (2)`` suffix.

    Always materializes — the caller resolves the cwd (project_path or per-task
    workspace fallback), so this endpoint never has to decide where files go.
    """
    if not db.get(Task, task_id):
        raise HTTPException(404, "Task not found")
    cwd = body.cwd
    if not cwd or not os.path.isabs(cwd):
        raise HTTPException(400, "cwd must be an absolute path")

    files_root = getattr(request.app.state, "files_dir", None)
    if not files_root:
        raise HTTPException(500, "Files root not configured on backend")

    items = (
        db.query(FileItem)
        .filter(
            FileItem.source == "task-attachment",
            FileItem.source_task_id == task_id,
            FileItem.deleted_at.is_(None),
        )
        .order_by(FileItem.created_at)
        .all()
    )

    dest_dir = os.path.join(cwd, "attachments")
    result = TaskAttachmentMaterializeResult(destination_dir=dest_dir)
    if not items:
        return result

    try:
        os.makedirs(dest_dir, exist_ok=True)
    except OSError as e:
        raise HTTPException(500, f"Could not create attachments dir: {e}") from e

    for it in items:
        src_abs = os.path.abspath(os.path.join(files_root, it.storage_path))
        if not os.path.isfile(src_abs):
            result.errors.append(
                TaskAttachmentMaterializeError(name=it.name, error="source-missing")
            )
            continue

        primary_dest = os.path.join(dest_dir, it.name)
        if os.path.exists(primary_dest):
            existing_sha = _sha256_of(primary_dest)
            if existing_sha and existing_sha == it.sha256:
                result.skipped.append(it.name)
                continue
            dest_abs = _unique_dest(dest_dir, it.name)
        else:
            dest_abs = primary_dest

        try:
            shutil.copy2(src_abs, dest_abs)
            result.copied.append(os.path.basename(dest_abs))
        except OSError as e:
            result.errors.append(
                TaskAttachmentMaterializeError(name=it.name, error=str(e))
            )

    return result
