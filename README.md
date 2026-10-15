# Dal dischetto: rigori isometrici multiplayer su OpenShift

Gioco a 2 giocatori: uno tira, l'altro para, poi i ruoli si invertono. Entrambi
scelgono tra **sinistra alto, destra alto, centro, sinistra basso, destra basso**
(angoli visti dal tiratore). Se il portiere indovina è parata, altrimenti gol.
Vince il primo che arriva a **5 gol**.

Tutto parte da **una sola repo Git**: frontend, backend Python, configurazioni e
manifest OpenShift. Kustomize genera ConfigMap e Secret e li monta nei
Deployment; le BuildConfig costruiscono le immagini; il database Redis gira in
una StatefulSet con volume persistente.

---

## 1. Architettura (come nel diagramma)

```
User ─► Route-frontend ─► Service-frontend ─► Deployment-frontend
                                              └ Pod: nginx-frontend + ConfigMap-frontend
                                                   │  /api/auth/*  ──► Service-auth ─► Deployment-auth
                                                   │  /api/game/*  ──► Service-backend ─► Deployment-backend
                                                                          (WebSocket)       │
                                                     Deployment-backend ──► Service-auth (verifica token)
                    Deployment-auth + Deployment-backend ──► Service-headless ─► StatefulSet-db
                                                                                 └ Pod: redis-db + Secret-db
                                                                                    └ PVC ─► PV

Repo-Git ─► BuildConfig ─► ImageStream ─► (trigger) ─► Deployment     (codice)
Repo-Git ─► Kustomize ─► ConfigMap/Secret con hash ─► Deployment     (configurazione)
```

| Elemento del diagramma | File nella repo |
|---|---|
| Route-frontend | `openshift/base/frontend/route.yaml` |
| Service-frontend / Deployment-frontend | `openshift/base/frontend/` |
| nginx-frontend (immagine) | `frontend/Dockerfile`, `frontend/public/` |
| ConfigMap-frontend | generata da `openshift/base/config/frontend/default.conf` |
| Service-auth / Deployment-auth | `openshift/base/auth/` |
| Service-backend / Deployment-backend | `openshift/base/backend/` |
| python-app | `services/auth/`, `services/backend/` |
| ConfigMap-backend | generata da `openshift/base/config/backend.env` |
| Secret-db | generato da `openshift/base/config/db.env` |
| Service-headless | `openshift/base/db/service-headless.yaml` |
| StatefulSet-db, redis-db, PVC | `openshift/base/db/statefulset.yaml` |
| PV | creato in automatico dallo StorageClass del cluster |
| Repo-Git → build | `openshift/base/builds/` |
| Kustomize | `openshift/base/kustomization.yaml`, `openshift/overlays/dev/` |

### Struttura della repo

```
football-openshift/
├── frontend/
│   ├── Dockerfile                 nginx non privilegiato + file statici
│   └── public/                    index.html, css/, js/iso.js (motore isometrico), js/app.js
├── services/
│   ├── auth/                      FastAPI: registrazione, login, sessioni su Redis
│   └── backend/                   FastAPI: WebSocket di gioco, matchmaking, classifica
├── openshift/
│   ├── base/
│   │   ├── kustomization.yaml     ◄── il cuore dell'automazione
│   │   ├── build-settings.yaml    ◄── URL della repo Git (unico punto da modificare)
│   │   ├── config/                sorgenti di ConfigMap e Secret
│   │   ├── builds/                ImageStream + BuildConfig
│   │   ├── db/                    StatefulSet Redis + Service headless
│   │   ├── auth/  backend/  frontend/
│   ├── overlays/dev/              namespace e personalizzazioni per ambiente
│   └── gitops/                    Application Argo CD (opzionale, automazione totale)
└── scripts/deploy.sh              deploy con un comando
```

---

## 2. Come funziona l'automazione

**Configurazione (Kustomize).** In `kustomization.yaml` non scriviamo ConfigMap a
mano: `configMapGenerator` e `secretGenerator` le costruiscono dai file in
`config/`. Kustomize aggiunge al nome un hash del contenuto
(`config-backend-kc9d8h2tf4`) e riscrive i riferimenti dentro Deployment e
StatefulSet. Quindi: modifichi `backend.env` → cambia l'hash → cambia il pod
template → OpenShift fa rollout con la nuova configurazione. Nessun riavvio manuale.

**Codice (BuildConfig + ImageStream).** Ogni componente ha una BuildConfig che
clona la repo, entra nella sua cartella (`contextDir`) e builda il Dockerfile.
L'immagine finisce nell'ImageStream (`auth:latest`, ecc.). L'annotazione
`image.openshift.io/triggers` sui Deployment fa sì che a ogni nuova immagine il
Deployment si aggiorni da solo.

**Partenza delle build.** Trigger `ConfigChange`: la prima build parte appena la
BuildConfig viene creata. Trigger `GitHub`/`Generic`: le successive partono a
ogni push grazie al webhook.

**URL della repo scritto una volta.** `build-settings.yaml` è una ConfigMap
"locale" (annotazione `config.kubernetes.io/local-config`): Kustomize la usa
tramite `replacements` per scrivere `uri` e `ref` in tutte le BuildConfig, ma
non la crea nel cluster.

**Database.** La StatefulSet crea il pod `db-0` e, dal `volumeClaimTemplates`, la
PVC `data-db-0`; il PV viene creato dallo StorageClass di default. I servizi si
collegano a `db-headless:6379` con la password presa dal Secret-db.

---

## 3. Passo passo

### Passo 0: prerequisiti
- Un cluster OpenShift 4.x (va bene anche Developer Sandbox o OpenShift Local/CRC)
- `oc` installato e login fatto (`oc login ...`)
- La repo su GitHub/GitLab (pubblica, oppure vedi il passo 7 per le private)

### Passo 1: carica il progetto su Git
```bash
cd football-openshift
git init && git add . && git commit -m "Prima versione"
git branch -M main
git remote add origin https://github.com/TUO-UTENTE/football-openshift.git
git push -u origin main
```

### Passo 2: indica la repo a Kustomize
In `openshift/base/build-settings.yaml` metti il tuo URL e il branch:
```yaml
data:
  gitUri: https://github.com/TUO-UTENTE/football-openshift.git
  gitRef: main
```

### Passo 3: cambia le password
- `openshift/base/config/db.env` → `REDIS_PASSWORD`
- `openshift/base/config/webhook.env` → `WebHookSecretKey`

Poi `git commit` e `git push`: le BuildConfig clonano la repo, quindi deve essere aggiornata.

### Passo 4: controlla cosa genera Kustomize (facoltativo)
```bash
oc kustomize openshift/overlays/dev | less
```
Vedrai ConfigMap e Secret con l'hash nel nome, i Deployment che li referenziano
e le BuildConfig con il tuo URL.

### Passo 5: deploy
Con lo script (crea il progetto, applica, aspetta build e rollout, stampa l'URL):
```bash
./scripts/deploy.sh
```
Oppure a mano:
```bash
oc new-project football
oc apply -k openshift/overlays/dev
oc get builds -w                     # le 3 build partono da sole
oc get pods -w                       # db-0, auth, backend, frontend
oc get route frontend -o jsonpath='{.spec.host}'
```
Durante la prima build i pod dei Deployment possono restare per qualche minuto in
`ImagePullBackOff`: è normale, appena l'immagine arriva nell'ImageStream il
trigger aggiorna il Deployment e i pod partono.

### Passo 6: gioca
Apri l'URL della Route in due browser diversi (o una finestra normale e una
anonima), registra due utenti, premi **Cerca un avversario** su entrambi.
Puoi scegliere l'angolo con il mouse o con i tasti 1–5.

### Passo 7: build automatiche a ogni push (webhook)
```bash
oc describe bc/frontend | grep -A1 "Webhook GitHub"
```
L'URL contiene `<secret>`: sostituiscilo con il valore di `WebHookSecretKey`.
Su GitHub: **Settings → Webhooks → Add webhook**, incolla l'URL, content type
`application/json`, evento *push*. Ripeti per `auth` e `backend` (3 webhook).

Il cluster deve essere raggiungibile da GitHub. Se non lo è (es. CRC in locale),
lancia le build a mano: `oc start-build auth --follow`.

Repo privata:
```bash
oc create secret generic git-credentials --type=kubernetes.io/basic-auth \
  --from-literal=username=TUO-UTENTE --from-literal=password=TOKEN
```
e decommenta `sourceSecret` in `openshift/base/builds/buildconfigs.yaml`.

### Passo 8: automazione totale con GitOps (opzionale ma consigliato)
Installa l'operatore **Red Hat OpenShift GitOps** da OperatorHub, aggiorna
`repoURL` in `openshift/gitops/argocd-application.yaml` e:
```bash
oc apply -f openshift/gitops/argocd-application.yaml
```
Da qui in poi non serve più nessun comando:

| Cosa modifichi e pushi | Cosa succede da solo |
|---|---|
| `services/**` o `frontend/**` | webhook → build → nuova immagine → rollout |
| `config/*.env`, `default.conf` | Argo CD → Kustomize → nuovo hash → rollout |
| manifest (repliche, risorse, StatefulSet) | Argo CD applica la differenza |
| file rimosso dalla repo | Argo CD rimuove la risorsa (`prune`) |

---

## 4. Modifiche tipiche

**Partita a 3 gol invece di 5**: in `config/backend.env` metti `GOALS_TO_WIN=3`,
poi push (con GitOps) o `oc apply -k openshift/overlays/dev`.

**Un ambiente di produzione**: copia `overlays/dev` in `overlays/prod`, cambia
`namespace`, le repliche e il livello di log. Lancia `./scripts/deploy.sh prod`.

**Più tempo per scegliere**: `ROUND_TIMEOUT_SECONDS` in `backend.env`.

---

## 5. Test in locale senza OpenShift
```bash
docker run -d --name redis -p 6379:6379 redis:7.2-alpine
cd services/auth && pip install -r requirements.txt
uvicorn app.main:app --port 8001
# in un altro terminale
cd services/backend && pip install -r requirements.txt
AUTH_URL=http://localhost:8001 uvicorn app.main:app --port 8002
```
Per il frontend serve un proxy che inoltri `/api/auth` alla 8001 e `/api/game`
alla 8002: usa `config/frontend/default.conf` con nginx, sostituendo `auth:8080`
e `backend:8080` con `host.docker.internal:8001/8002`.

---

## 6. Problemi frequenti

| Sintomo | Causa e soluzione |
|---|---|
| Build ferma su `toomanyrequests` | Limite di Docker Hub sull'immagine nginx. Cambia il `FROM` del frontend con un mirror (es. `public.ecr.aws/nginx/nginx-unprivileged:1.27-alpine`) o crea un pull secret Docker Hub. |
| Pod in `ImagePullBackOff` per sempre | La build è fallita: `oc logs bc/auth`. |
| PVC `data-db-0` in `Pending` | Il cluster non ha uno StorageClass di default: aggiungi `storageClassName` nel `volumeClaimTemplates`. |
| Il frontend dice "Connessione persa" | Controlla `oc logs deploy/backend` e che la Route abbia il timeout `1h`. |
| `oc apply -k` fa ripartire i pod | Il campo `image` torna a `nome:latest` e il trigger lo riscrive: è innocuo. Con Argo CD è già gestito da `ignoreDifferences`. |

---

## 7. Note per la produzione

- **Password**: le password non vanno committate in chiaro. Usa Sealed Secrets o
  External Secrets Operator e rimuovi `db.env` dalla repo. Le password degli
  utenti sono salvate con hash PBKDF2-SHA256 e salt, mai in chiaro.
- **Scalabilità del backend**: coda e partite sono in memoria, per questo
  `backend` ha 1 replica e strategia `Recreate`. Per scalare, sposta la coda su
  Redis (liste + pub/sub) e abilita la sticky session sulla Route.
- **Auth** e **frontend** sono stateless e possono scalare liberamente.
- **Redis** gira come singola istanza con persistenza AOF sul PVC; per l'alta
  affidabilità valuta Redis Sentinel o un operatore.

### Dati salvati su Redis
```
user:<username>     HASH   nome, cognome, username, password (hash)
session:<token>     STRING username, scade dopo SESSION_TTL_SECONDS
leaderboard:wins    ZSET   vittorie per utente
stats:<username>    HASH   wins, losses, played
matches:history     LIST   ultime 100 partite
```
Per controllarli:
```bash
oc exec -it db-0 -- sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning keys "*"'
```
