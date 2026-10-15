"""
Logica di gioco dei rigori.

Regole:
- 2 giocatori. A ogni round uno tira e l'altro para, poi i ruoli si invertono.
- Entrambi scelgono una direzione: TL (sinistra alto), TR (destra alto), C (centro),
  BL (sinistra basso), BR (destra basso). Le direzioni sono viste dal tiratore.
- Se il portiere sceglie la stessa direzione del tiro -> parata, altrimenti gol.
- Vince il primo che arriva a GOALS_TO_WIN gol (default 5).
- Se un giocatore non sceglie entro ROUND_TIMEOUT secondi, il server sceglie a caso.
- Se un giocatore si disconnette, l'altro vince a tavolino.

Protocollo WebSocket (JSON):
  client -> server: {"type": "choose", "dir": "TL"} | {"type": "ping"}
  server -> client: waiting, match_start, round_start, choice_ack, opponent_ready,
                    round_result, game_over, error, pong
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import uuid
from dataclasses import dataclass, field

import redis.asyncio as redis
from fastapi import WebSocket

DIRECTIONS = ("TL", "TR", "C", "BL", "BR")
COLORS = ("blue", "orange")

log = logging.getLogger("game")


@dataclass
class GameSettings:
    goals_to_win: int = 5
    round_timeout: float = 15.0
    result_pause: float = 3.5


@dataclass(eq=False)
class Player:
    ws: WebSocket
    username: str
    display: str
    color: str = ""
    match: "Match | None" = None

    async def send(self, payload: dict) -> bool:
        try:
            await self.ws.send_json(payload)
            return True
        except Exception:  # noqa: BLE001 - socket già chiuso
            return False


class Store:
    """Persistenza dei risultati su Redis (classifica e storico)."""

    def __init__(self, db: redis.Redis):
        self.db = db

    async def record_result(self, winner: str, loser: str, score: dict, reason: str):
        pipe = self.db.pipeline()
        pipe.zincrby("leaderboard:wins", 1, winner)
        pipe.zincrby("leaderboard:wins", 0, loser)
        pipe.hincrby(f"stats:{winner.lower()}", "wins", 1)
        pipe.hincrby(f"stats:{winner.lower()}", "played", 1)
        pipe.hincrby(f"stats:{loser.lower()}", "losses", 1)
        pipe.hincrby(f"stats:{loser.lower()}", "played", 1)
        pipe.lpush("matches:history", json.dumps({
            "winner": winner, "loser": loser, "score": score,
            "reason": reason, "ts": int(time.time()),
        }))
        pipe.ltrim("matches:history", 0, 99)
        await pipe.execute()

    async def leaderboard(self, limit: int = 10) -> list[dict]:
        rows = await self.db.zrevrange("leaderboard:wins", 0, limit - 1, withscores=True)
        return [{"username": u, "wins": int(s)} for u, s in rows]


class Match:
    def __init__(self, p1: Player, p2: Player, store: Store, cfg: GameSettings):
        self.id = uuid.uuid4().hex[:8]
        self.players = [p1, p2]
        for p, color in zip(self.players, COLORS):
            p.color = color
            p.match = self
        self.store = store
        self.cfg = cfg
        self.score = {p1.username: 0, p2.username: 0}
        self.shooter_idx = 0
        self.round_no = 0
        self.choices: dict[str, str] = {}
        self.round_open = False
        self.round_done = asyncio.Event()
        self.finished = False
        self.task: asyncio.Task | None = None

    # -- utilità ---------------------------------------------------------------
    def other(self, p: Player) -> Player:
        return self.players[1] if p is self.players[0] else self.players[0]

    def public_players(self) -> list[dict]:
        return [{"username": p.username, "display": p.display, "color": p.color}
                for p in self.players]

    async def broadcast(self, build):
        await asyncio.gather(*(p.send(build(p)) for p in self.players))

    # -- ciclo partita ---------------------------------------------------------
    async def run(self):
        log.info("Match %s: %s vs %s", self.id, *[p.username for p in self.players])
        try:
            await self.broadcast(lambda p: {
                "type": "match_start",
                "match_id": self.id,
                "you": p.username,
                "players": self.public_players(),
                "goals_to_win": self.cfg.goals_to_win,
            })
            await asyncio.sleep(1.5)
            while not self.finished:
                await self.play_round()
                if self.finished:
                    break
                leader = max(self.players, key=lambda p: self.score[p.username])
                if self.score[leader.username] >= self.cfg.goals_to_win:
                    await self.finish(leader, "goals")
                    break
                self.shooter_idx ^= 1  # si invertono i ruoli
        except asyncio.CancelledError:
            pass

    async def play_round(self):
        self.round_no += 1
        shooter = self.players[self.shooter_idx]
        keeper = self.other(shooter)
        self.choices = {}
        self.round_done = asyncio.Event()
        self.round_open = True

        await self.broadcast(lambda p: {
            "type": "round_start",
            "round": self.round_no,
            "shooter": shooter.username,
            "keeper": keeper.username,
            "role": "shooter" if p is shooter else "keeper",
            "timeout": self.cfg.round_timeout,
            "score": self.score,
        })
        try:
            await asyncio.wait_for(self.round_done.wait(), self.cfg.round_timeout)
        except asyncio.TimeoutError:
            pass
        self.round_open = False
        if self.finished:
            return

        auto = {}
        shot = self.choices.get(shooter.username)
        if shot is None:
            shot, auto[shooter.username] = random.choice(DIRECTIONS), True
        dive = self.choices.get(keeper.username)
        if dive is None:
            dive, auto[keeper.username] = random.choice(DIRECTIONS), True

        goal = shot != dive
        if goal:
            self.score[shooter.username] += 1

        await self.broadcast(lambda p: {
            "type": "round_result",
            "round": self.round_no,
            "shooter": shooter.username,
            "keeper": keeper.username,
            "shot": shot,
            "dive": dive,
            "goal": goal,
            "auto": auto,
            "score": self.score,
        })
        await asyncio.sleep(self.cfg.result_pause)  # tempo per l'animazione lato client

    async def choose(self, player: Player, direction: str):
        if not self.round_open or direction not in DIRECTIONS:
            return
        if player.username in self.choices:
            return  # la scelta non si può cambiare
        self.choices[player.username] = direction
        await player.send({"type": "choice_ack", "dir": direction})
        await self.other(player).send({"type": "opponent_ready"})
        if len(self.choices) == 2:
            self.round_done.set()

    async def finish(self, winner: Player, reason: str):
        if self.finished:
            return
        self.finished = True
        self.round_done.set()
        loser = self.other(winner)
        score = dict(self.score)
        try:
            await self.store.record_result(winner.username, loser.username, score, reason)
        except Exception:  # noqa: BLE001
            log.exception("Impossibile salvare il risultato su Redis")
        await self.broadcast(lambda p: {
            "type": "game_over",
            "winner": winner.username,
            "reason": reason,
            "score": score,
        })
        for p in self.players:
            p.match = None
        log.info("Match %s finito: vince %s (%s) %s", self.id, winner.username, reason, score)

    async def forfeit(self, leaver: Player):
        if self.finished:
            return
        await self.finish(self.other(leaver), "forfeit")
        if self.task and self.task is not asyncio.current_task():
            self.task.cancel()


@dataclass
class Matchmaker:
    """Coda 1v1 in memoria. Per questo il Deployment backend ha 1 replica."""
    store: Store
    cfg: GameSettings
    waiting: Player | None = None
    active: set = field(default_factory=set)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def join(self, player: Player) -> bool:
        async with self.lock:
            if self.waiting is None:
                self.waiting = player
                await player.send({"type": "waiting"})
                return True
            if self.waiting.username == player.username:
                await player.send({"type": "error",
                                   "message": "Sei già in coda da un'altra finestra."})
                return False
            opponent, self.waiting = self.waiting, None

        match = Match(opponent, player, self.store, self.cfg)
        match.task = asyncio.create_task(match.run())
        self.active.add(match)
        match.task.add_done_callback(lambda _t: self.active.discard(match))
        return True

    async def choose(self, player: Player, direction: str):
        if player.match:
            await player.match.choose(player, direction)

    async def leave(self, player: Player):
        async with self.lock:
            if self.waiting is player:
                self.waiting = None
        if player.match:
            await player.match.forfeit(player)
