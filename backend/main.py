import argparse
import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI

from database import init_db

# Import models so they register with Base.metadata before create_all()
import models  # noqa: F401


@asynccontextmanager
async def lifespan(application: FastAPI):
    db_path = application.state.db_path
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    init_db(db_path)
    print(f"[Cerebro] Database initialized at {db_path}")
    yield


app = FastAPI(title="Cerebro Backend", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db-path", type=str, default=os.path.join(".", "cerebro.db"))
    args = parser.parse_args()

    app.state.db_path = os.path.abspath(args.db_path)

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")
