from datetime import datetime

from pydantic import BaseModel, Field


class TaskCreate(BaseModel):
    title: str = Field(..., max_length=200)
    description_md: str = ""
    column: str = "backlog"
    expert_id: str | None = None
    parent_task_id: str | None = None
    priority: str = "normal"
    start_at: datetime | None = None
    due_at: datetime | None = None
    project_path: str | None = None
    tags: list[str] = Field(default_factory=list)


class TaskUpdate(BaseModel):
    title: str | None = None
    description_md: str | None = None
    expert_id: str | None = None
    priority: str | None = None
    start_at: datetime | None = None
    due_at: datetime | None = None
    project_path: str | None = None
    tags: list[str] | None = None


class TaskMove(BaseModel):
    column: str
    position: float | None = None


class TaskRead(BaseModel):
    id: str
    title: str
    description_md: str
    column: str
    expert_id: str | None
    parent_task_id: str | None
    priority: str
    start_at: datetime | None
    due_at: datetime | None
    position: float
    run_id: str | None
    last_error: str | None
    project_path: str | None
    tags: list[str] = []
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    checklist: list["ChecklistItemRead"] = []
    comment_count: int = 0
    checklist_total: int = 0
    checklist_done: int = 0

    class Config:
        from_attributes = True


class ChecklistItemCreate(BaseModel):
    body: str = Field(..., max_length=500)


class ChecklistItemUpdate(BaseModel):
    body: str | None = None
    is_done: bool | None = None
    position: float | None = None


class ChecklistItemRead(BaseModel):
    id: str
    task_id: str
    body: str
    is_done: bool
    position: float
    promoted_task_id: str | None
    created_at: datetime

    class Config:
        from_attributes = True


class CommentCreate(BaseModel):
    kind: str = "comment"
    body_md: str


class CommentRead(BaseModel):
    id: str
    task_id: str
    kind: str
    author_kind: str
    expert_id: str | None
    body_md: str
    triggered_run_id: str | None
    created_at: datetime

    class Config:
        from_attributes = True


class TaskStats(BaseModel):
    backlog: int = 0
    in_progress: int = 0
    to_review: int = 0
    completed: int = 0
    error: int = 0
