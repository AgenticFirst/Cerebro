import argparse
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Literal

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import selectinload

from database import get_db, init_db

# Import models so they register with Base.metadata before create_all()
import models  # noqa: F401
from models import Conversation, Message, Setting

from memory.router import router as memory_router
from agent_memory.router import router as agent_memory_router
from experts.router import router as experts_router
from agent_runs.router import router as agent_runs_router
from engine.router import router as engine_router
from routines.router import router as routines_router
from webhooks.router import router as webhooks_router
from scripts.router import router as scripts_router
from skills.router import skills_router, expert_skills_router
from voice.router import router as voice_router, init_voice_singletons
from sandbox.router import router as sandbox_router
from tasks.router import router as tasks_router
from sync.router import router as sync_router


@asynccontextmanager
async def lifespan(application: FastAPI):
    db_path = application.state.db_path
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    init_db(db_path)
    print(f"[Cerebro] Database initialized at {db_path}")

    agent_memory_dir = getattr(application.state, "agent_memory_dir", None)
    if agent_memory_dir:
        os.makedirs(agent_memory_dir, exist_ok=True)
        print(f"[Cerebro] Agent memory directory: {agent_memory_dir}")

    # Voice models (bundled with the app)
    voice_models_dir = getattr(application.state, "voice_models_dir", None)
    if voice_models_dir:
        init_voice_singletons()
        print(f"[Cerebro] Voice models directory: {voice_models_dir}")

    # Seed builtin skills
    from database import SessionLocal
    from skills.seed import seed_builtin_skills
    if SessionLocal is not None:
        db = SessionLocal()
        try:
            seed_builtin_skills(db)
            print("[Cerebro] Builtin skills seeded")
        finally:
            db.close()

    yield


app = FastAPI(title="Cerebro Backend", lifespan=lifespan)
app.include_router(memory_router, prefix="/memory")
app.include_router(agent_memory_router, prefix="/agent-memory")
app.include_router(experts_router, prefix="/experts")
app.include_router(agent_runs_router, prefix="/agent-runs")
app.include_router(engine_router, prefix="/engine")
app.include_router(routines_router, prefix="/routines")
app.include_router(webhooks_router, prefix="/webhooks")
app.include_router(scripts_router, prefix="/scripts")
app.include_router(skills_router)
app.include_router(expert_skills_router)
app.include_router(voice_router, prefix="/voice")
app.include_router(sandbox_router, prefix="/sandbox")
app.include_router(tasks_router, prefix="/tasks")
app.include_router(sync_router, prefix="/sync")


@app.get("/health")
def health():
    return {"status": "ok"}


# ── Pydantic schemas ──────────────────────────────────────────────


class SettingUpsert(BaseModel):
    value: str


class SettingResponse(BaseModel):
    key: str
    value: str
    updated_at: datetime

    model_config = {"from_attributes": True}


class ConversationCreate(BaseModel):
    id: str
    title: str = "New Chat"
    expert_id: str | None = None


class MessageCreate(BaseModel):
    id: str
    role: str
    content: str
    expert_id: str | None = None
    agent_run_id: str | None = None
    metadata: dict | None = None


class MessageUpdate(BaseModel):
    metadata: dict | None = None


class MessageResponse(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    expert_id: str | None = None
    agent_run_id: str | None = None
    metadata: dict | None = Field(None, validation_alias="metadata_parsed")
    created_at: datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class ConversationResponse(BaseModel):
    id: str
    title: str
    expert_id: str | None = None
    created_at: datetime
    updated_at: datetime
    messages: list[MessageResponse]

    model_config = {"from_attributes": True}


class ConversationListResponse(BaseModel):
    conversations: list[ConversationResponse]


# ── Settings endpoints ────────────────────────────────────────────


@app.get("/settings", response_model=list[SettingResponse])
def list_settings(db=Depends(get_db)):
    return db.query(Setting).order_by(Setting.key).all()


@app.get("/settings/{key}", response_model=SettingResponse)
def get_setting(key: str, db=Depends(get_db)):
    setting = db.get(Setting, key)
    if not setting:
        raise HTTPException(status_code=404, detail="Setting not found")
    return setting


@app.put("/settings/{key}", response_model=SettingResponse)
def upsert_setting(key: str, body: SettingUpsert, db=Depends(get_db)):
    setting = db.get(Setting, key)
    if setting:
        setting.value = body.value
        setting.updated_at = models._utcnow()
    else:
        setting = Setting(key=key, value=body.value)
        db.add(setting)
    db.commit()
    db.refresh(setting)
    return setting


@app.delete("/settings/{key}", status_code=204)
def delete_setting(key: str, db=Depends(get_db)):
    setting = db.get(Setting, key)
    if setting:
        db.delete(setting)
        db.commit()
    return Response(status_code=204)


# ── Conversation endpoints ────────────────────────────────────────


@app.get("/conversations", response_model=ConversationListResponse)
def list_conversations(
    db=Depends(get_db),
    expert_id: str | None = Query(None),
    scope: Literal["general", "expert", "all"] = Query("all"),
):
    query = db.query(Conversation).options(selectinload(Conversation.messages))
    if expert_id is not None:
        query = query.filter(Conversation.expert_id == expert_id)
    elif scope == "general":
        query = query.filter(Conversation.expert_id.is_(None))
    elif scope == "expert":
        query = query.filter(Conversation.expert_id.is_not(None))
    convs = query.order_by(Conversation.updated_at.desc()).all()
    return ConversationListResponse(conversations=convs)


@app.post("/conversations", response_model=ConversationResponse, status_code=201)
def create_conversation(body: ConversationCreate, db=Depends(get_db)):
    existing = db.get(Conversation, body.id)
    if existing:
        raise HTTPException(status_code=409, detail="Conversation already exists")
    conv = Conversation(id=body.id, title=body.title, expert_id=body.expert_id)
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


@app.post("/conversations/{conv_id}/messages", response_model=MessageResponse, status_code=201)
def create_message(conv_id: str, body: MessageCreate, db=Depends(get_db)):
    conv = db.get(Conversation, conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    msg = Message(
        id=body.id,
        conversation_id=conv_id,
        role=body.role,
        content=body.content,
        expert_id=body.expert_id,
        agent_run_id=body.agent_run_id,
        metadata_json=json.dumps(body.metadata) if body.metadata else None,
    )
    db.add(msg)
    conv.updated_at = models._utcnow()
    db.commit()
    db.refresh(msg)
    return msg


@app.patch("/conversations/{conv_id}/messages/{msg_id}", response_model=MessageResponse)
def patch_message(conv_id: str, msg_id: str, body: MessageUpdate, db=Depends(get_db)):
    msg = db.query(Message).filter(Message.id == msg_id, Message.conversation_id == conv_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    if body.metadata is not None:
        existing = msg.metadata_parsed or {}
        merged = {**existing, **body.metadata}
        msg.metadata_json = json.dumps(merged)
    db.commit()
    db.refresh(msg)
    return msg


@app.delete("/conversations/{conv_id}", status_code=204)
def delete_conversation(conv_id: str, db=Depends(get_db)):
    conv = db.get(Conversation, conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    db.delete(conv)
    db.commit()
    return Response(status_code=204)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db-path", type=str, default=os.path.join(".", "cerebro.db"))
    parser.add_argument(
        "--agent-memory-dir",
        type=str,
        default=os.path.join(".", "agent-memory"),
    )
    parser.add_argument(
        "--voice-models-dir",
        type=str,
        default=os.path.join(".", "voice-models"),
    )
    args = parser.parse_args()

    app.state.db_path = os.path.abspath(args.db_path)
    app.state.agent_memory_dir = os.path.abspath(args.agent_memory_dir)
    app.state.voice_models_dir = os.path.abspath(args.voice_models_dir)

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")
