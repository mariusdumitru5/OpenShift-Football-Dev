"""
Servizio BACKEND (gioco)
------------------------
- WS  /api/game/ws?token=...   -> partita multiplayer in tempo reale
- GET /api/game/leaderboard    -> classifica vittorie (da Redis)
- GET /healthz                 -> probe per OpenShift

Il token viene validato chiamando il servizio auth (Service-auth), come nel diagramma.
"""
import json
import logging
import os
from contextlib import asynccontextmanager

import httpx
import redis.asyncio as redis
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status

from .game import GameSettings, Matchmaker, Player, Store

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
REDIS_DB = int(os.getenv("REDIS_DB", "0"))
REDIS_PASSWORD = os.getenv("REDIS_PASSWORD") or None
AUTH_URL = os.getenv("AUTH_URL", "http://auth:8080").rstrip("/")

settings = GameSettings(
    goals_to_win=int(os.getenv("GOALS_TO_WIN", "5")),
    round_timeout=float(os.getenv("ROUND_TIMEOUT_SECONDS", "15")),
    result_pause=float(os.getenv("RESULT_PAUSE_SECONDS", "3.5")),
)

logging.basicConfig(level=os.getenv("LOG_LEVEL", "info").upper())
log = logging.getLogger("backend")

state: dict = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    db = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB,
                     password=REDIS_PASSWORD, decode_responses=True)
    state["db"] = db
    state["http"] = httpx.AsyncClient(timeout=5.0)
    state["store"] = Store(db)
    state["mm"] = Matchmaker(state["store"], settings)
    log.info("Backend pronto. Auth=%s Redis=%s:%s regole=%s",
             AUTH_URL, REDIS_HOST, REDIS_PORT, settings)
    yield
    await state["http"].aclose()
    await db.aclose()


app = FastAPI(title="football-backend", lifespan=lifespan)


async def verify_token(token: str) -> dict | None:
    if not token:
        return None
    try:
        r = await state["http"].get(f"{AUTH_URL}/api/auth/verify",
                                    headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError:
        log.exception("Servizio auth non raggiungibile")
        return None
    return r.json() if r.status_code == 200 else None


@app.websocket("/api/game/ws")
async def game_ws(ws: WebSocket, token: str = ""):
    await ws.accept()
    user = await verify_token(token)
    if not user:
        await ws.send_json({"type": "error", "message": "Sessione non valida, accedi di nuovo."})
        await ws.close(code=4401)
        return

    player = Player(ws=ws, username=user["username"],
                    display=f'{user["nome"]} {user["cognome"]}')
    mm: Matchmaker = state["mm"]
    try:
        if not await mm.join(player):
            await ws.close(code=4409)
            return
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = msg.get("type")
            if kind == "choose":
                await mm.choose(player, str(msg.get("dir", "")))
            elif kind == "ping":
                await player.send({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        log.exception("Errore sul WebSocket di %s", player.username)
    finally:
        await mm.leave(player)


@app.get("/api/game/leaderboard")
async def leaderboard():
    return {"leaderboard": await state["store"].leaderboard()}


@app.get("/healthz")
async def healthz():
    try:
        await state["db"].ping()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"redis: {exc}") from exc
    return {"status": "ok"}
