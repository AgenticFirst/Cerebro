"""FastAPI router for /tasks/* endpoints."""

from __future__ import annotations

import json
import os

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, WebSocket

from database import get_db
from models import (
    Conversation,
    RunRecord,
    Task,
    TaskEvent,
    _utcnow,
    _uuid_hex,
)
from engine.schemas import RunRecordResponse

from .schemas import (
    ClarifyResponse,
    ClarifySubmit,
    DevServerStatus,
    RunInfo,
    TaskCreate,
    TaskDetailResponse,
    TaskEventBatch,
    TaskEventResponse,
    TaskFinalize,
    TaskFollowUp,
    TaskFollowUpResponse,
    TaskListResponse,
    TaskPhaseUpdate,
    TaskPlan,
    TaskPlanUpsert,
    TaskResponse,
    TaskRunStart,
    TaskRunStartResponse,
    WorkspaceFileResponse,
    WorkspaceTreeResponse,
)
from .workspace import create_workspace, delete_workspace, list_tree, read_file

router = APIRouter(tags=["tasks"])


# ── Helpers ───────────────────────────────────────────────────────


def _data_dir(request: Request) -> str:
    db_path = getattr(request.app.state, "db_path", None)
    if not db_path:
        raise HTTPException(status_code=500, detail="db_path not configured")
    return os.path.dirname(db_path)


def _parse_plan(task: Task) -> TaskPlan | None:
    if not task.plan_json:
        return None
    try:
        data = json.loads(task.plan_json)
        return TaskPlan(**data)
    except Exception:
        return None


def _parse_run_info(task: Task) -> RunInfo | None:
    if not task.run_info_json:
        return None
    try:
        return RunInfo(**json.loads(task.run_info_json))
    except Exception:
        return None


def _parse_clarifications(task: Task) -> dict | None:
    if not task.clarifications_json:
        return None
    try:
        return json.loads(task.clarifications_json)
    except Exception:
        return None


def _parse_created_experts(task: Task) -> list[str]:
    if not task.created_expert_ids_json:
        return []
    try:
        ids = json.loads(task.created_expert_ids_json)
        return [str(x) for x in ids] if isinstance(ids, list) else []
    except Exception:
        return []


def _run_to_response(run: RunRecord) -> RunRecordResponse:
    return RunRecordResponse(
        id=run.id,
        routine_id=run.routine_id,
        expert_id=run.expert_id,
        conversation_id=run.conversation_id,
        parent_run_id=run.parent_run_id,
        status=run.status,
        run_type=run.run_type,
        trigger=run.trigger,
        dag_json=run.dag_json,
        total_steps=run.total_steps,
        completed_steps=run.completed_steps,
        error=run.error,
        failed_step_id=run.failed_step_id,
        started_at=run.started_at,
        completed_at=run.completed_at,
        duration_ms=run.duration_ms,
        steps=None,
    )


def _task_to_response(task: Task) -> TaskResponse:
    return TaskResponse(
        id=task.id,
        title=task.title,
        goal=task.goal,
        status=task.status,
        expert_hint_id=task.expert_hint_id,
        template_id=task.template_id,
        run_id=task.run_id,
        conversation_id=task.conversation_id,
        plan=_parse_plan(task),
        deliverable_markdown=task.deliverable_markdown,
        deliverable_title=task.deliverable_title,
        deliverable_kind=task.deliverable_kind or "markdown",
        workspace_path=task.workspace_path,
        run_info=_parse_run_info(task),
        clarifications=_parse_clarifications(task),
        skip_clarification=task.skip_clarification,
        max_turns=task.max_turns,
        max_phases=task.max_phases,
        created_expert_ids=_parse_created_experts(task),
        error=task.error,
        created_at=task.created_at,
        started_at=task.started_at,
        completed_at=task.completed_at,
    )


# ── Task CRUD ─────────────────────────────────────────────────────


@router.post("", response_model=TaskResponse, status_code=201)
def create_task(body: TaskCreate, db=Depends(get_db)):
    task = Task(
        id=_uuid_hex(),
        title=body.title.strip() or "Untitled task",
        goal=body.goal.strip(),
        status="pending",
        expert_hint_id=body.expert_hint_id,
        template_id=body.template_id,
        max_turns=max(5, min(body.max_turns, 200)),
        max_phases=max(1, min(body.max_phases, 12)),
        skip_clarification=body.skip_clarification,
        deliverable_kind="markdown",
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return _task_to_response(task)


@router.get("", response_model=TaskListResponse)
def list_tasks(
    status: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    q = db.query(Task)
    if status:
        q = q.filter(Task.status == status)
    total = q.count()
    rows = q.order_by(Task.created_at.desc()).offset(offset).limit(limit).all()
    return TaskListResponse(
        tasks=[_task_to_response(t) for t in rows],
        total=total,
    )


@router.get("/{task_id}", response_model=TaskDetailResponse)
def get_task(task_id: str, request: Request, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    base = _task_to_response(task).model_dump()

    run = db.get(RunRecord, task.run_id) if task.run_id else None
    run_resp = _run_to_response(run) if run else None

    child_runs: list[RunRecordResponse] = []
    if task.run_id:
        # Flatten descendants one level at a time
        frontier = [task.run_id]
        while frontier:
            kids = (
                db.query(RunRecord)
                .filter(RunRecord.parent_run_id.in_(frontier))
                .order_by(RunRecord.started_at)
                .all()
            )
            if not kids:
                break
            child_runs.extend(_run_to_response(k) for k in kids)
            frontier = [k.id for k in kids]

    # Dev server snapshot (best-effort — registry may not be loaded yet)
    dev_server = None
    try:
        from .dev_server import get_registry  # type: ignore
        registry = get_registry(request.app)
        dev_server = registry.status(task_id)
    except Exception:
        dev_server = None

    return TaskDetailResponse(
        **base,
        run=run_resp,
        child_runs=child_runs,
        dev_server=dev_server,
    )


@router.delete("/{task_id}", status_code=204)
def delete_task(task_id: str, request: Request, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        return Response(status_code=204)

    # Stop any running dev server first
    try:
        from .dev_server import get_registry  # type: ignore
        registry = get_registry(request.app)
        registry.stop(task_id)
    except Exception:
        pass

    # Delete workspace (with realpath-prefix safety check inside)
    try:
        delete_workspace(_data_dir(request), task_id)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    db.delete(task)
    db.commit()
    return Response(status_code=204)


# ── Run start / clarify / finalize ────────────────────────────────


@router.post("/{task_id}/run", response_model=TaskRunStartResponse)
def start_task_run(task_id: str, body: TaskRunStart, request: Request, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    data_dir = _data_dir(request)

    # Ensure conversation exists (one per task, reused across clarify+execute)
    conv_id = task.conversation_id
    if not conv_id:
        conv_id = _uuid_hex()
        conv = Conversation(id=conv_id, title=task.title[:255] or "Task")
        db.add(conv)
        task.conversation_id = conv_id

    # Workspace is always created (cheap, needed even for markdown tasks
    # as scratch space — and must live under data_dir for sandbox writes)
    workspace_path = create_workspace(data_dir, task_id)
    task.workspace_path = workspace_path

    # Mint a fresh run_record per subprocess (clarify and execute are
    # separate runs so Activity shows them distinctly)
    run_id = _uuid_hex()
    run = RunRecord(
        id=run_id,
        conversation_id=conv_id,
        run_type="task",
        trigger="manual",
        status="running",
        parent_run_id=None,
    )
    db.add(run)
    task.run_id = run_id

    if body.phase == "clarify":
        task.status = "clarifying"
    else:
        task.status = "running"
        if not task.started_at:
            task.started_at = _utcnow()

    db.commit()

    return TaskRunStartResponse(
        task_id=task_id,
        run_id=run_id,
        conversation_id=conv_id,
        workspace_path=workspace_path,
    )


def _format_answers_block(questions: list[dict], answers: list[dict]) -> str:
    """Produce a human-readable block that gets pasted into the execute envelope."""
    q_by_id = {q["id"]: q for q in questions}
    lines: list[str] = []
    for a in answers:
        q = q_by_id.get(a["id"])
        label = q.get("q") if q else a["id"]
        value = a.get("answer")
        if isinstance(value, bool):
            value_str = "yes" if value else "no"
        elif value is None or value == "":
            value_str = "(no answer — use your judgment)"
        else:
            value_str = str(value)
        lines.append(f"- **{label}** {value_str}")
    return "\n".join(lines) if lines else "(user skipped — use your best judgment)"


@router.post("/{task_id}/clarify", response_model=ClarifyResponse)
def submit_clarification(task_id: str, body: ClarifySubmit, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    existing = _parse_clarifications(task) or {}
    questions = existing.get("questions", [])

    answers_dump = [a.model_dump() for a in body.answers]
    existing["answers"] = answers_dump
    task.clarifications_json = json.dumps(existing)
    task.status = "awaiting_clarification"  # transient; runner flips to running on next /run
    db.commit()

    answers_block = _format_answers_block(questions, answers_dump)
    return ClarifyResponse(task_id=task_id, answers_block=answers_block)


@router.post("/{task_id}/clarifications", response_model=TaskResponse)
def set_clarification_questions(task_id: str, body: dict, db=Depends(get_db)):
    """Renderer-driven upsert of the question set parsed from the clarify run.

    Body shape: ``{"questions": [{id, q, kind, options?, default?, placeholder?}]}``
    """
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    existing = _parse_clarifications(task) or {}
    existing["questions"] = body.get("questions", [])
    task.clarifications_json = json.dumps(existing)
    task.status = "awaiting_clarification"
    db.commit()
    db.refresh(task)
    return _task_to_response(task)


@router.post("/{task_id}/plan", response_model=TaskResponse)
def upsert_plan(task_id: str, body: TaskPlanUpsert, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    plan = TaskPlan(phases=body.phases)
    task.plan_json = plan.model_dump_json()
    if body.kind:
        task.deliverable_kind = body.kind
    if task.status not in ("completed", "failed", "cancelled"):
        task.status = "running"
    db.commit()
    db.refresh(task)
    return _task_to_response(task)


@router.patch("/{task_id}/phase", response_model=TaskResponse)
def update_phase(task_id: str, body: TaskPhaseUpdate, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    plan = _parse_plan(task)
    if not plan:
        raise HTTPException(status_code=400, detail="Plan not set yet")

    for phase in plan.phases:
        if phase.id == body.phase_id:
            phase.status = body.status
            if body.child_run_id is not None:
                phase.child_run_id = body.child_run_id
            if body.summary is not None:
                phase.summary = body.summary
            break
    else:
        raise HTTPException(status_code=404, detail=f"Phase {body.phase_id} not in plan")

    task.plan_json = plan.model_dump_json()
    db.commit()
    db.refresh(task)
    return _task_to_response(task)


@router.post("/{task_id}/finalize", response_model=TaskResponse)
def finalize_task(task_id: str, body: TaskFinalize, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    task.status = body.status
    task.completed_at = _utcnow()
    if body.deliverable_markdown is not None:
        task.deliverable_markdown = body.deliverable_markdown
    if body.deliverable_title is not None:
        task.deliverable_title = body.deliverable_title
    if body.deliverable_kind is not None:
        task.deliverable_kind = body.deliverable_kind
    if body.run_info is not None:
        task.run_info_json = body.run_info.model_dump_json()
    if body.error is not None:
        task.error = body.error
    if body.created_expert_ids is not None:
        task.created_expert_ids_json = json.dumps(body.created_expert_ids)

    if task.run_id:
        run = db.get(RunRecord, task.run_id)
        if run and run.status == "running":
            run.status = body.status if body.status != "cancelled" else "cancelled"
            run.completed_at = _utcnow()
            if run.started_at:
                run.duration_ms = int(
                    (run.completed_at - run.started_at).total_seconds() * 1000
                )
            if body.error:
                run.error = body.error

    db.commit()
    db.refresh(task)
    return _task_to_response(task)


@router.post("/{task_id}/cancel", response_model=TaskResponse)
def cancel_task(task_id: str, request: Request, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if task.status in ("completed", "failed", "cancelled"):
        return _task_to_response(task)

    task.status = "cancelled"
    task.completed_at = _utcnow()

    if task.run_id:
        run = db.get(RunRecord, task.run_id)
        if run and run.status == "running":
            run.status = "cancelled"
            run.completed_at = _utcnow()

    db.commit()

    # Stop dev server if any
    try:
        from .dev_server import get_registry  # type: ignore
        registry = get_registry(request.app)
        registry.stop(task_id)
    except Exception:
        pass

    db.refresh(task)
    return _task_to_response(task)


# ── Follow-up ────────────────────────────────────────────────────


@router.post("/{task_id}/follow-up", response_model=TaskFollowUpResponse)
def follow_up_task(task_id: str, body: TaskFollowUp, request: Request, db=Depends(get_db)):
    """Start a follow-up run on a completed/failed task.

    Reuses the same workspace and conversation. Transitions the task back to
    running, mints a new run_record, and returns pre-formatted context for the
    follow-up prompt envelope.
    """
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if task.status not in ("completed", "failed", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot follow up on a task with status '{task.status}' — task must be terminal",
        )

    data_dir = _data_dir(request)

    # Ensure workspace exists (should already from the original run)
    workspace_path = task.workspace_path
    if not workspace_path:
        workspace_path = create_workspace(data_dir, task_id)
        task.workspace_path = workspace_path

    # Ensure conversation exists
    conv_id = task.conversation_id
    if not conv_id:
        conv_id = _uuid_hex()
        conv = Conversation(id=conv_id, title=task.title[:255] or "Task")
        db.add(conv)
        task.conversation_id = conv_id

    # Mint a new run_record for this follow-up
    run_id = _uuid_hex()
    run = RunRecord(
        id=run_id,
        conversation_id=conv_id,
        run_type="task",
        trigger="follow_up",
        status="running",
        parent_run_id=None,
    )
    db.add(run)
    task.run_id = run_id
    task.status = "running"
    task.error = None
    task.completed_at = None
    db.commit()

    # Build follow-up context block for the prompt envelope
    MAX_DELIVERABLE_CHARS = 50_000
    raw_deliverable = task.deliverable_markdown or "(no previous deliverable)"
    if len(raw_deliverable) > MAX_DELIVERABLE_CHARS:
        previous_deliverable = raw_deliverable[:MAX_DELIVERABLE_CHARS] + "\n\n...(truncated — full deliverable is in the workspace)"
    else:
        previous_deliverable = raw_deliverable
    context_parts = [
        f"Original goal: {task.goal}",
        f"Deliverable kind: {task.deliverable_kind or 'markdown'}",
    ]

    # Include clarification answers if they exist
    clarifications = _parse_clarifications(task)
    if clarifications and clarifications.get("answers"):
        questions = clarifications.get("questions", [])
        answers = clarifications["answers"]
        answers_block = _format_answers_block(questions, answers)
        context_parts.append(f"User's clarification answers:\n{answers_block}")

    context_parts.append(f"\nPrevious deliverable:\n{previous_deliverable}")

    follow_up_context = "\n".join(context_parts)

    return TaskFollowUpResponse(
        task_id=task_id,
        run_id=run_id,
        conversation_id=conv_id,
        workspace_path=workspace_path,
        follow_up_context=follow_up_context,
    )


# ── Event persistence ────────────────────────────────────────────


@router.post("/{task_id}/events", status_code=201)
def append_events(task_id: str, body: TaskEventBatch, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Batch dedup: single query instead of per-event SELECT
    incoming_seqs = [item.seq for item in body.events]
    existing_seqs = set()
    if incoming_seqs:
        rows = (
            db.query(TaskEvent.seq)
            .filter(TaskEvent.task_id == task_id, TaskEvent.seq.in_(incoming_seqs))
            .all()
        )
        existing_seqs = {r[0] for r in rows}

    created = 0
    for item in body.events:
        if item.seq in existing_seqs:
            continue
        db.add(TaskEvent(
            id=_uuid_hex(),
            task_id=task_id,
            seq=item.seq,
            kind=item.kind,
            payload_json=item.payload_json,
            ts=item.ts or _utcnow(),
        ))
        created += 1
    db.commit()
    return {"created": created}


@router.get("/{task_id}/events", response_model=list[TaskEventResponse])
def list_events(
    task_id: str,
    after_seq: int = Query(-1, ge=-1),
    limit: int = Query(1000, ge=1, le=5000),
    db=Depends(get_db),
):
    q = (
        db.query(TaskEvent)
        .filter(TaskEvent.task_id == task_id)
        .filter(TaskEvent.seq > after_seq)
        .order_by(TaskEvent.seq)
        .limit(limit)
    )
    return [TaskEventResponse.model_validate(e) for e in q.all()]


# ── Workspace browsing ───────────────────────────────────────────


@router.get("/{task_id}/workspace/tree", response_model=WorkspaceTreeResponse)
def get_workspace_tree(task_id: str, request: Request, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task or not task.workspace_path:
        raise HTTPException(status_code=404, detail="Workspace not found")
    files, truncated = list_tree(task.workspace_path)
    return WorkspaceTreeResponse(files=files, truncated=truncated)


@router.get("/{task_id}/workspace/file", response_model=WorkspaceFileResponse)
def get_workspace_file(
    task_id: str,
    path: str = Query(..., description="relative path inside workspace"),
    request: Request = None,
    db=Depends(get_db),
):
    task = db.get(Task, task_id)
    if not task or not task.workspace_path:
        raise HTTPException(status_code=404, detail="Workspace not found")
    try:
        result = read_file(task.workspace_path, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return WorkspaceFileResponse(**result)


# ── Dev server ───────────────────────────────────────────────────


@router.post("/{task_id}/dev-server/start")
def start_dev_server(task_id: str, request: Request, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not task.run_info_json or not task.workspace_path:
        raise HTTPException(
            status_code=400,
            detail="Task has no run_info or workspace — not a code_app",
        )

    from .dev_server import get_registry
    registry = get_registry(request.app)

    try:
        run_info = RunInfo(**json.loads(task.run_info_json))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid run_info: {exc}") from exc

    pid = registry.start(task_id, task.workspace_path, run_info)
    return {"task_id": task_id, "pid": pid, "stream_url": f"/tasks/{task_id}/dev-server/stream"}


@router.post("/{task_id}/dev-server/stop")
def stop_dev_server(task_id: str, request: Request, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    from .dev_server import get_registry
    registry = get_registry(request.app)
    stopped = registry.stop(task_id)
    return {"stopped": stopped}


@router.get("/{task_id}/dev-server/status", response_model=DevServerStatus)
def get_dev_server_status(task_id: str, request: Request, db=Depends(get_db)):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    from .dev_server import get_registry
    registry = get_registry(request.app)
    snapshot = registry.status(task_id) or {
        "running": False,
        "pid": None,
        "url": None,
        "started_at": None,
        "stdout_tail": None,
        "preview_type": None,
    }
    return DevServerStatus(**snapshot)


@router.websocket("/{task_id}/dev-server/stream")
async def dev_server_stream_ws(ws: WebSocket, task_id: str):
    from .dev_server import dev_server_stream
    await dev_server_stream(ws, task_id)
