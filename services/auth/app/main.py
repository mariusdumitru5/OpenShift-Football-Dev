"""
Servizio AUTH
-------------
- POST /api/auth/register  -> salva nome, cognome, username, password (hash) su Redis
- POST /api/auth/login     -> verifica credenziali e crea una sessione (token) su Redis
- GET  /api/auth/verify    -> dato un token "Bearer", restituisce l'utente (usato dal backend di gioco)
- POST /api/auth/logout    -> invalida il token
- GET  /healthz            -> probe per OpenShift

Struttura dati su Redis:
  user:<username_lowercase>  HASH  {nome, cognome, username, password}
  session:<token>            STRING username_lowercase   (con TTL)
"""
import asyncio
import hashlib
import hmac
import logging
import os
import secrets
from contextlib import asynccontextmanager

import redis.asyncio as redis
from fastapi import FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

# --- Configurazione (arriva da ConfigMap-backend e Secret-db) -----------------
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
REDIS_DB = int(os.getenv("REDIS_DB", "0"))
REDIS_PASSWORD = os.getenv("REDIS_PASSWORD") or None
SESSION_TTL = int(os.getenv("SESSION_TTL_SECONDS", "86400"))
PBKDF2_ITERATIONS = int(os.getenv("PBKDF2_ITERATIONS", "200000"))

logging.basicConfig(level=os.getenv("LOG_LEVEL", "info").upper())
log = logging.getLogger("auth")

db: redis.Redis | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global db
    db = redis.Redis(
        host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB,
        password=REDIS_PASSWORD, decode_responses=True,
    )
    log.info("Connesso a Redis %s:%s", REDIS_HOST, REDIS_PORT)
    yield
    await db.aclose()


app = FastAPI(title="football-auth", lifespan=lifespan)


# --- Modelli ------------------------------------------------------------------
class RegisterIn(BaseModel):
    nome: str = Field(min_length=1, max_length=50)
    cognome: str = Field(min_length=1, max_length=50)
    username: str = Field(min_length=3, max_length=20, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=6, max_length=128)


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=20)
    password: str = Field(min_length=1, max_length=128)


# --- Password hashing (PBKDF2, solo libreria standard) -----------------------
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _algo, iterations, salt_hex, digest_hex = stored.split("$")
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations)
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def user_key(username: str) -> str:
    return f"user:{username.lower()}"


def bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token mancante")
    return authorization.split(" ", 1)[1].strip()


# --- Endpoint -----------------------------------------------------------------
@app.post("/api/auth/register", status_code=status.HTTP_201_CREATED)
async def register(body: RegisterIn):
    key = user_key(body.username)
    # HSETNX è atomico: se due persone registrano lo stesso username, solo una vince
    created = await db.hsetnx(key, "username", body.username)
    if not created:
        raise HTTPException(status.HTTP_409_CONFLICT, "Username già in uso")
    hashed = await asyncio.to_thread(hash_password, body.password)
    await db.hset(key, mapping={
        "nome": body.nome.strip(),
        "cognome": body.cognome.strip(),
        "password": hashed,
    })
    log.info("Registrato utente %s", body.username)
    return {"username": body.username}


@app.post("/api/auth/login")
async def login(body: LoginIn):
    user = await db.hgetall(user_key(body.username))
    stored = user.get("password") if user else None
    if not stored or not await asyncio.to_thread(verify_password, body.password, stored):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Username o password errati")
    token = secrets.token_urlsafe(32)
    await db.set(f"session:{token}", body.username.lower(), ex=SESSION_TTL)
    return {
        "token": token,
        "username": user["username"],
        "nome": user["nome"],
        "cognome": user["cognome"],
    }


@app.get("/api/auth/verify")
async def verify(authorization: str | None = Header(default=None)):
    token = bearer_token(authorization)
    username = await db.get(f"session:{token}")
    if not username:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessione scaduta")
    user = await db.hgetall(user_key(username))
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Utente non trovato")
    return {"username": user["username"], "nome": user["nome"], "cognome": user["cognome"]}


@app.post("/api/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(authorization: str | None = Header(default=None)):
    token = bearer_token(authorization)
    await db.delete(f"session:{token}")


@app.get("/healthz")
async def healthz():
    try:
        await db.ping()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"redis: {exc}") from exc
    return {"status": "ok"}
