import argparse
import os
from contextlib import asynccontextmanager
from datetime import datetime

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import selectinload

from credentials import get_credential, set_credential
from database import get_db, init_db

# Import models so they register with Base.metadata before create_all()
import models  # noqa: F401
from models import Conversation, Message

from local_models.catalog import recover_interrupted
from local_models.router import init_singletons
from local_models.router import router as models_router


@asynccontextmanager
async def lifespan(application: FastAPI):
    db_path = application.state.db_path
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    init_db(db_path)
    print(f"[Cerebro] Database initialized at {db_path}")

    models_dir = application.state.models_dir
    os.makedirs(models_dir, exist_ok=True)
    recover_interrupted(models_dir)
    init_singletons()
    print(f"[Cerebro] Models directory: {models_dir}")

    yield


app = FastAPI(title="Cerebro Backend", lifespan=lifespan)
app.include_router(models_router, prefix="/models")


@app.get("/health")
def health():
    return {"status": "ok"}


# ── Credential push (from Electron main process) ─────────────────


class CredentialPush(BaseModel):
    key: str
    value: str | None = None


@app.post("/credentials")
def push_credential(body: CredentialPush):
    set_credential(body.key, body.value)
    return {"status": "ok"}


# ── Pydantic schemas ──────────────────────────────────────────────


class ConversationCreate(BaseModel):
    id: str
    title: str = "New Chat"


class MessageCreate(BaseModel):
    id: str
    role: str
    content: str
    model: str | None = None
    token_count: int | None = None


class MessageResponse(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    model: str | None
    token_count: int | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ConversationResponse(BaseModel):
    id: str
    title: str
    created_at: datetime
    updated_at: datetime
    messages: list[MessageResponse]

    model_config = {"from_attributes": True}


class ConversationListResponse(BaseModel):
    conversations: list[ConversationResponse]


# ── Conversation endpoints ────────────────────────────────────────


@app.get("/conversations", response_model=ConversationListResponse)
def list_conversations(db=Depends(get_db)):
    convs = (
        db.query(Conversation)
        .options(selectinload(Conversation.messages))
        .order_by(Conversation.updated_at.desc())
        .all()
    )
    return ConversationListResponse(conversations=convs)


@app.post("/conversations", response_model=ConversationResponse, status_code=201)
def create_conversation(body: ConversationCreate, db=Depends(get_db)):
    existing = db.get(Conversation, body.id)
    if existing:
        raise HTTPException(status_code=409, detail="Conversation already exists")
    conv = Conversation(id=body.id, title=body.title)
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
        model=body.model,
        token_count=body.token_count,
    )
    db.add(msg)
    conv.updated_at = models._utcnow()
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
    parser.add_argument("--models-dir", type=str, default=os.path.join(".", "models"))
    args = parser.parse_args()

    app.state.db_path = os.path.abspath(args.db_path)
    app.state.models_dir = os.path.abspath(args.models_dir)

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")
