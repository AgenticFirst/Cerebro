import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from models import RunRecord, Task, TaskChecklistItem, TaskComment
from sandbox.validation import cerebro_data_dir, validate_link_path

from .schemas import (
    ChecklistItemCreate,
    ChecklistItemRead,
    ChecklistItemUpdate,
    CommentCreate,
    CommentRead,
    TaskCreate,
    TaskMove,
    TaskRead,
    TaskStats,
    TaskUpdate,
)

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


def _task_to_read(task: Task, db: Session) -> TaskRead:
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
        tags=_parse_tags(task.tags),
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

    for key, val in updates.items():
        setattr(task, key, val)
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
    _add_system_comment(db, task.id, "Task cancelled, moved back to Backlog")
    db.commit()
    db.refresh(task)
    return _task_to_read(task, db)


# ── Run event callback (called by Electron main process) ──

@router.post("/{task_id}/run-event")
def handle_run_event(task_id: str, event: dict, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")

    event_type = event.get("type")
    run_id = event.get("run_id")

    if event_type == "run_started":
        # Ensure a RunRecord exists for this run_id — tasks.run_id has a FK to it.
        # The Electron runtime mints the runId but doesn't create the DB row for task runs,
        # so we create it here on first sight.
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
        _add_system_comment(db, task.id, "Expert started working")
    elif event_type == "run_completed":
        task.column = "to_review"
        task.completed_at = _utcnow()
        if run_id:
            run = db.get(RunRecord, run_id)
            if run:
                run.status = "completed"
                run.completed_at = _utcnow()
        _add_system_comment(db, task.id, "Expert finished — ready for review")
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

    db.commit()
    db.refresh(task)
    return {"ok": True}


# ── Comments ──

@router.post("/{task_id}/comments", response_model=CommentRead)
def create_comment(task_id: str, body: CommentCreate, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    if body.kind not in ("comment", "instruction"):
        raise HTTPException(400, f"Invalid comment kind: {body.kind}")

    comment = TaskComment(
        task_id=task_id,
        kind=body.kind,
        author_kind="user",
        body_md=body.body_md,
    )
    db.add(comment)
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
