"""FastAPI router for engine run records — /engine/* endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from database import get_db
from models import ApprovalRequest, ExecutionEventRecord, RunRecord, StepRecord, _uuid_hex, _utcnow

from .schemas import (
    ApprovalCreate,
    ApprovalListResponse,
    ApprovalResolve,
    ApprovalResponse,
    EventBatchCreate,
    EventRecordResponse,
    RunRecordCreate,
    RunRecordListResponse,
    RunRecordResponse,
    RunRecordUpdate,
    StepRecordCreate,
    StepRecordResponse,
    StepRecordUpdate,
)

router = APIRouter(tags=["engine"])


# ── Helpers ───────────────────────────────────────────────────────


def _run_to_response(run: RunRecord, steps: list[StepRecordResponse] | None = None) -> RunRecordResponse:
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
        steps=steps,
    )


# ── Run CRUD ──────────────────────────────────────────────────────


@router.post("/runs", response_model=RunRecordResponse, status_code=201)
def create_run(body: RunRecordCreate, db=Depends(get_db)):
    run = RunRecord(
        id=body.id or _uuid_hex(),
        routine_id=body.routine_id,
        expert_id=body.expert_id,
        conversation_id=body.conversation_id,
        parent_run_id=body.parent_run_id,
        run_type=body.run_type,
        trigger=body.trigger,
        dag_json=body.dag_json,
        total_steps=body.total_steps,
        status="running",
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return _run_to_response(run)


@router.get("/runs", response_model=RunRecordListResponse)
def list_runs(
    routine_id: str | None = None,
    status: str | None = None,
    run_type: str | None = None,
    trigger: str | None = None,
    parent_run_id: str | None = None,
    conversation_id: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    q = db.query(RunRecord)
    if routine_id:
        q = q.filter(RunRecord.routine_id == routine_id)
    if status:
        q = q.filter(RunRecord.status == status)
    if run_type:
        q = q.filter(RunRecord.run_type == run_type)
    if trigger:
        q = q.filter(RunRecord.trigger == trigger)
    if parent_run_id:
        q = q.filter(RunRecord.parent_run_id == parent_run_id)
    if conversation_id:
        q = q.filter(RunRecord.conversation_id == conversation_id)

    total = q.count()
    runs = q.order_by(RunRecord.started_at.desc()).offset(offset).limit(limit).all()
    return RunRecordListResponse(
        runs=[_run_to_response(r) for r in runs],
        total=total,
    )


@router.get("/runs/{run_id}", response_model=RunRecordResponse)
def get_run(run_id: str, db=Depends(get_db)):
    run = db.get(RunRecord, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run record not found")
    steps = (
        db.query(StepRecord)
        .filter(StepRecord.run_id == run_id)
        .order_by(StepRecord.order_index)
        .all()
    )
    step_responses = [StepRecordResponse.model_validate(s) for s in steps]
    return _run_to_response(run, steps=step_responses)


@router.get("/runs/{run_id}/children", response_model=RunRecordListResponse)
def list_children(
    run_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    q = db.query(RunRecord).filter(RunRecord.parent_run_id == run_id)
    total = q.count()
    children = q.order_by(RunRecord.started_at).offset(offset).limit(limit).all()
    return RunRecordListResponse(
        runs=[_run_to_response(r) for r in children],
        total=total,
    )


@router.patch("/runs/{run_id}", response_model=RunRecordResponse)
def update_run(run_id: str, body: RunRecordUpdate, db=Depends(get_db)):
    run = db.get(RunRecord, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run record not found")

    updates = body.model_dump(exclude_unset=True)
    for key, val in updates.items():
        setattr(run, key, val)
    db.commit()
    db.refresh(run)
    return _run_to_response(run)


@router.delete("/runs/{run_id}", status_code=204)
def delete_run(run_id: str, db=Depends(get_db)):
    run = db.get(RunRecord, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run record not found")
    db.delete(run)
    db.commit()
    return Response(status_code=204)


# ── Step CRUD ─────────────────────────────────────────────────────


@router.post("/runs/{run_id}/steps", response_model=list[StepRecordResponse], status_code=201)
def batch_create_steps(run_id: str, body: list[StepRecordCreate], db=Depends(get_db)):
    run = db.get(RunRecord, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run record not found")

    records = []
    for item in body:
        rec = StepRecord(
            id=item.id or _uuid_hex(),
            run_id=run_id,
            step_id=item.step_id,
            step_name=item.step_name,
            action_type=item.action_type,
            status=item.status,
            order_index=item.order_index,
            input_json=item.input_json,
        )
        db.add(rec)
        records.append(rec)
    db.commit()
    for rec in records:
        db.refresh(rec)
    return [StepRecordResponse.model_validate(r) for r in records]


@router.get("/runs/{run_id}/steps", response_model=list[StepRecordResponse])
def list_steps(run_id: str, db=Depends(get_db)):
    steps = (
        db.query(StepRecord)
        .filter(StepRecord.run_id == run_id)
        .order_by(StepRecord.order_index)
        .all()
    )
    return [StepRecordResponse.model_validate(s) for s in steps]


@router.patch("/runs/{run_id}/steps/{step_record_id}", response_model=StepRecordResponse)
def update_step(run_id: str, step_record_id: str, body: StepRecordUpdate, db=Depends(get_db)):
    step = db.get(StepRecord, step_record_id)
    if not step or step.run_id != run_id:
        raise HTTPException(status_code=404, detail="Step record not found")

    updates = body.model_dump(exclude_unset=True)
    for key, val in updates.items():
        setattr(step, key, val)
    db.commit()
    db.refresh(step)
    return StepRecordResponse.model_validate(step)


# ── Event CRUD ────────────────────────────────────────────────────


@router.post("/runs/{run_id}/events", status_code=201)
def batch_create_events(run_id: str, body: EventBatchCreate, db=Depends(get_db)):
    run = db.get(RunRecord, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run record not found")

    for item in body.events:
        rec = ExecutionEventRecord(
            id=_uuid_hex(),
            run_id=run_id,
            seq=item.seq,
            event_type=item.event_type,
            step_id=item.step_id,
            payload_json=item.payload_json,
            timestamp=item.timestamp,
        )
        db.add(rec)
    db.commit()
    return {"created": len(body.events)}


@router.get("/runs/{run_id}/events", response_model=list[EventRecordResponse])
def list_events(
    run_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=1000),
    db=Depends(get_db),
):
    events = (
        db.query(ExecutionEventRecord)
        .filter(ExecutionEventRecord.run_id == run_id)
        .order_by(ExecutionEventRecord.seq)
        .offset(offset)
        .limit(limit)
        .all()
    )
    return [EventRecordResponse.model_validate(e) for e in events]


# ── Approval CRUD ────────────────────────────────────────────────


@router.post("/approvals", response_model=ApprovalResponse, status_code=201)
def create_approval(body: ApprovalCreate, db=Depends(get_db)):
    run = db.get(RunRecord, body.run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run record not found")
    approval = ApprovalRequest(
        id=body.id,
        run_id=body.run_id,
        step_id=body.step_id,
        step_name=body.step_name,
        summary=body.summary,
        payload_json=body.payload_json,
        status="pending",
    )
    db.add(approval)
    db.commit()
    db.refresh(approval)
    return ApprovalResponse.model_validate(approval)


@router.get("/approvals", response_model=ApprovalListResponse)
def list_approvals(
    status: str | None = None,
    run_id: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    db=Depends(get_db),
):
    q = db.query(ApprovalRequest)
    if status:
        q = q.filter(ApprovalRequest.status == status)
    if run_id:
        q = q.filter(ApprovalRequest.run_id == run_id)

    total = q.count()
    approvals = q.order_by(ApprovalRequest.requested_at.desc()).offset(offset).limit(limit).all()
    return ApprovalListResponse(
        approvals=[ApprovalResponse.model_validate(a) for a in approvals],
        total=total,
    )


@router.get("/approvals/pending/count")
def pending_approval_count(db=Depends(get_db)):
    count = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending").count()
    return {"count": count}


@router.get("/approvals/{approval_id}", response_model=ApprovalResponse)
def get_approval(approval_id: str, db=Depends(get_db)):
    approval = db.get(ApprovalRequest, approval_id)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval request not found")
    return ApprovalResponse.model_validate(approval)


@router.patch("/approvals/{approval_id}/resolve", response_model=ApprovalResponse)
def resolve_approval(approval_id: str, body: ApprovalResolve, db=Depends(get_db)):
    approval = db.get(ApprovalRequest, approval_id)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval request not found")
    if approval.status != "pending":
        raise HTTPException(status_code=409, detail="Approval already resolved")

    approval.status = body.decision
    approval.decision_reason = body.reason
    approval.resolved_at = _utcnow()
    db.commit()
    db.refresh(approval)
    return ApprovalResponse.model_validate(approval)


@router.post("/runs/recover-stale")
def recover_stale_runs(db=Depends(get_db)):
    """Mark stale running/paused runs as failed and expire their pending approvals.
    Also recovers stale tasks stuck in running/clarifying/planning status."""
    now = _utcnow()

    stale_runs = (
        db.query(RunRecord)
        .filter(RunRecord.status.in_(["running", "paused"]))
        .all()
    )
    recovered_runs = 0
    expired_approvals = 0
    for run in stale_runs:
        run.status = "failed"
        run.error = "Recovered after unexpected shutdown"
        run.completed_at = now
        recovered_runs += 1

        pending = (
            db.query(ApprovalRequest)
            .filter(ApprovalRequest.run_id == run.id, ApprovalRequest.status == "pending")
            .all()
        )
        for approval in pending:
            approval.status = "expired"
            approval.resolved_at = now
            expired_approvals += 1

    # Recover stale tasks (no subprocess is alive after restart)
    from models import Task
    stale_tasks = (
        db.query(Task)
        .filter(Task.status.in_(["running", "clarifying", "planning"]))
        .all()
    )
    recovered_tasks = 0
    for task in stale_tasks:
        task.status = "failed"
        task.error = "Interrupted — app was closed while task was running"
        task.completed_at = now
        recovered_tasks += 1

    db.commit()
    return {
        "recovered_runs": recovered_runs,
        "expired_approvals": expired_approvals,
        "recovered_tasks": recovered_tasks,
    }
