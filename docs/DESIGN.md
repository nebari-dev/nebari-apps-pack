# Nebari Apps Pack — Design Document

**Status:** Draft for review
**Author:** (you) + Claude
**Date:** 2026-06-15
**Related:** `nebari-operator`, `nebari-llm-serving-pack`, `nebi`, `jhub-apps`

---

## 1. Summary

The **Nebari Apps Pack** is a Nebari Software Pack that lets users launch, manage, and
observe **web applications** on a Nebari Kubernetes cluster — both **static** apps (HTML/JS
bundles) and **Python** apps (Panel, Streamlit, Gradio, Dash, Voila, FastAPI, custom). Apps
run as **pods** behind Nebari's gateway with Keycloak SSO.

Apps can be created and launched through four interfaces that all converge on a single
declarative resource (the `App` custom resource):

1. **A coding agent** (Claude Code, Codex) — generates an app, then the user launches it with
   **natural language** via an in-cluster **MCP server**.
2. **The MCP server** directly (tool calls: launch / list / access / remove / logs).
3. **A REST API** (programmatic CRUD + observability).
4. **A form-based UI** — like `jhub-apps`, but with **no JupyterHub dependency**; it talks to
   Nebari/Nebi instead.

Python apps run inside **pixi environments** managed by **Nebi** and delivered as **OCI
artifacts**. The pack has a **soft dependency** on Nebi: static apps and a built-in minimal
pixi path work without it, but full environment management delegates to Nebi when present.

A companion **Claude Code skill** teaches agents how to scaffold static and Python apps in the
exact layout this pack expects, so "generate then launch" is a smooth flow.

---

## 2. Goals & Non-Goals

### Goals
- Launch **static** and **Python web** apps as pods on Nebari, behind Keycloak SSO.
- One **declarative `App` resource** that the UI, API, MCP, *and* optional GitOps all produce.
- **Natural-language launching** of agent-generated apps via an in-cluster **MCP** server.
- **Python apps run in Nebi-managed pixi environments** (delivered as OCI artifacts).
- A **form-based launch UI** modeled on `jhub-apps` but free of JupyterHub.
- **CRUD + observability** API and UI (status, logs, events, resource usage, URLs).
- **MCP authenticates to Keycloak** (device flow for CLI/agents).
- A **skill** to scaffold compatible static and Python apps.
- Reuse Nebari conventions: Helm chart, `pack-metadata.yaml`, `NebariApp` for routing/auth.

### Non-Goals (v1)
- Not a general PaaS / arbitrary container scheduler (apps fit a small set of frameworks).
- Not replacing Nebi's environment management — the pack *consumes* it.
- Not building a new auth system — Keycloak (via nebari-operator) is the IdP.
- No multi-cluster federation in v1.
- No autoscaling beyond fixed replicas + optional scale-to-zero (deferred; see §16).
- Not a CI/CD system; the optional image-build path is intentionally minimal.

---

## 3. Background & Reused Building Blocks

The Nebari ecosystem already provides most of the primitives. The Apps Pack composes them
rather than reinventing.

| Component | What it gives us | How the Apps Pack uses it |
|---|---|---|
| **nebari-operator** (`reconcilers.nebari.dev/v1`, `NebariApp` CRD, Go/kubebuilder) | Given an *existing* Service, it provisions an `HTTPRoute`, a cert-manager `Certificate`, an Envoy `SecurityPolicy`, an **auto-provisioned Keycloak OIDC client**, and a **landing-page tile**. It does **not** create workloads. | The Apps operator creates the Deployment+Service, then emits a `NebariApp` per app to get routing + TLS + SSO + landing-page registration "for free." |
| **nebari-llm-serving-pack** (CRD + Go operator + UI, Helm) | The reference template for "a pack with a CRD, an operator, and a UI" wired through `NebariApp`. | Direct structural template for the Apps operator + Helm chart + `pack-metadata.yaml`. |
| **nebi** (Go, manages **pixi** "workspaces"; versions + publishes them to **OCI**; OIDC/Keycloak; casbin RBAC; async job + log streaming) | Authoritative **pixi environment** management; publishes solved envs as OCI artifacts. | Python app pods materialize their pixi env from a Nebi-published OCI artifact. The API queries Nebi for available environments to populate the launch form. |
| **jhub-apps** (FastAPI + React; app data model; framework→command mapping; form UX; sharing) | Battle-tested **app data model** and **framework→launch-command** logic, and a proven form UX. | We port the *model* and *framework command table*, drop the JupyterHub spawner/proxy/registry (replaced by k8s + nebari-operator), and reuse the form-UI patterns. |

### Key gap this pack fills
`NebariApp` routes to a Service that **must already exist**. Nothing in the ecosystem
*creates the workload* for an arbitrary user app. **The Apps Pack owns workload creation** —
that is its reason to exist.

---

## 4. Architecture Overview

```
                         ┌─────────────────────────────────────────────────────────┐
   Coding agent          │                    Nebari cluster                        │
   (Claude Code /         │                                                          │
    Codex) generates app  │   ┌────────────┐   reads/writes   ┌──────────────────┐  │
        │                 │   │  apps-mcp  │ ───────────────► │    apps-api      │  │
        │ "launch it"     │   │ (FastMCP)  │                  │   (FastAPI)      │  │
        ▼                 │   └────────────┘                  └───────┬──────────┘  │
   ┌──────────┐  HTTP/MCP │         ▲                                 │ creates/    │
   │  user /  │ ──────────┼─────────┘                                 │ patches     │
   │  agent   │           │   ┌────────────┐   REST/CRUD              ▼ App CR      │
   └──────────┘  ─────────┼─► │  apps-ui   │ ──────────────►  ┌──────────────────┐  │
        │  browser        │   │  (React)   │                  │  App CR (etcd)   │  │
        │                 │   └────────────┘                  │ apps.nebari.dev  │  │
        │                 │                                   └───────┬──────────┘  │
        │  (optional)     │   ┌────────────┐  git sync                │ watch       │
        │  GitOps ────────┼─► │  ArgoCD    │ ─────────────────────────┤             │
        │                 │   └────────────┘                          ▼             │
        │                 │                              ┌──────────────────────┐   │
        │                 │                              │   apps-operator      │   │
        │                 │                              │   (Go / kubebuilder) │   │
        │                 │                              └───────────┬──────────┘   │
        │                 │   reconciles into:                       │              │
        │                 │   ┌──────────────┐  ┌──────────┐  ┌──────▼────────┐     │
        │                 │   │  Deployment  │  │ Service  │  │   NebariApp   │     │
        │                 │   │  (app pod)   │  │          │  │ (routing+auth)│     │
        │                 │   └──────┬───────┘  └────┬─────┘  └──────┬────────┘     │
        │                 │          │ pulls env     │               │ reconciled   │
        │                 │   ┌──────▼───────┐       │               │ by           │
        │                 │   │ Nebi OCI env │       │               ▼ nebari-op     │
        │                 │   │ (pixi)       │       │   HTTPRoute + Cert + OIDC     │
        │                 │   └──────────────┘       │   + landing-page tile        │
        │                 │                          │                              │
        └─────────────────┼──────── app URL ─────────┴──── Envoy Gateway ───────────┘
          https://<app>.<cluster>           (Keycloak SSO via SecurityPolicy)
```

**The pattern in one sentence:** every producer (agent/MCP, API, UI, GitOps) ends up writing
an `App` CR; the **apps-operator** turns that into a Deployment + Service + `NebariApp`; the
**nebari-operator** turns the `NebariApp` into routing + TLS + SSO + a landing-page tile.

### Components built by this pack
| Component | Language / stack | Responsibility |
|---|---|---|
| **App CRD** | YAML (`apps.nebari.dev/v1alpha1`) | The declarative contract for an app. |
| **apps-operator** | Go + kubebuilder/controller-runtime | Reconcile `App` → Deployment, Service, `NebariApp`, status. |
| **apps-api** | Python FastAPI (async SQLAlchemy, pydantic v2) | CRUD + observability; writes `App` CRs; queries Nebi; the authority all clients use. |
| **apps-ui** | React + TS + Vite + shadcn/ui + Tailwind v4 | Form-based launch + management + observability dashboards. |
| **apps-mcp** | Python FastMCP | Agent-facing tools; Keycloak device-flow auth; calls apps-api. |
| **apps skill** | Claude Code skill (markdown + templates) | Scaffold static/Python apps in the expected layout. |

> **Why the API is the authority (not the CRD directly):** the API centralizes validation,
> RBAC, Nebi lookups, observability aggregation, and audit. MCP and UI never touch the
> Kubernetes API directly; they go through apps-api. GitOps is the one path that writes CRs
> without the API — that's an explicit, advanced opt-in.

---

## 5. The `App` Custom Resource

`App` is the heart of the design. Group `apps.nebari.dev`, version `v1alpha1`, **namespaced**
(an app lives in a project/team namespace labeled `nebari.dev/managed`).

```yaml
apiVersion: apps.nebari.dev/v1alpha1
kind: App
metadata:
  name: sales-dashboard
  namespace: team-analytics
  labels:
    apps.nebari.dev/owner: jbouder            # Keycloak sub / preferred_username
spec:
  displayName: "Sales Dashboard"
  description: "Q2 sales explorer"
  thumbnail: "data:image/png;base64,..."       # optional
  framework: streamlit                          # static|panel|streamlit|gradio|dash|voila|fastapi|custom
  owner: jbouder

  source:                                       # where the app's code comes from
    type: ociEnv                                # ociEnv | image | git | inline | pvc
    # --- type: ociEnv (Python via Nebi-managed pixi env) ---
    ociEnv:
      ref: "oci://quay.io/nebari/envs/team-analytics/ds-stack:v3"   # Nebi-published pixi env
      code:                                     # where the *app code* lives (env != code)
        type: git
        git: { url: "https://github.com/...", ref: "main", subdir: "app" }
      entrypoint: "app.py"                       # relative to code root
    # --- type: image (self-contained prebuilt image) ---
    # image: { repository: "quay.io/...", tag: "v1" }
    # --- type: git (static or build-on-pull) ---
    # git: { url: "...", ref: "main", subdir: "site" }
    # --- type: inline (small static content carried in the CR) ---
    # inline: { files: { "index.html": "<!doctype html>..." } }
    # --- type: pvc (content already on a volume) ---
    # pvc: { claimName: "docs-content", subPath: "site" }

  runtime:
    command: []                                 # optional override; otherwise derived from framework
    env:
      - name: LOG_LEVEL
        value: info
    resources:
      requests: { cpu: "250m", memory: "512Mi" }
      limits:   { cpu: "2",    memory: "4Gi" }
    keepAlive: false                            # if false + scaleToZero enabled, idle apps scale down
    replicas: 1

  access:
    public: false                              # true => no auth (anonymous)
    groups: ["analytics"]                      # Keycloak/OIDC groups allowed
    users:  ["alice", "bob"]                   # additional individual users
    subdomain: sales-dashboard                 # => https://sales-dashboard.<cluster-domain>

status:
  phase: Running                               # Pending|Building|Deploying|Running|Failed|Stopped
  url: "https://sales-dashboard.cluster.example.com"
  replicas: { desired: 1, ready: 1 }
  conditions:
    - type: WorkloadReady   ; status: "True"
    - type: RoutingReady    ; status: "True"   # mirrors NebariApp readiness
    - type: EnvironmentReady ; status: "True"  # pixi env materialized
  observedGeneration: 4
  lastTransitionTime: "2026-06-15T12:00:00Z"
  message: "All replicas ready"
```

### Framework → behavior
Ported from `jhub-apps`' command table, but the command targets a plain pod (no
`jhub-app-proxy`; auth is enforced at the gateway by the `NebariApp` `SecurityPolicy`).

| `framework` | Source types | Default container command (illustrative) | Listen port |
|---|---|---|---|
| `static` | git, pvc, inline | nginx/caddy serving the content root | 8080 |
| `streamlit` | ociEnv, image | `streamlit run $entrypoint --server.port=8080 --server.address=0.0.0.0 --server.headless=true` | 8080 |
| `panel` | ociEnv, image | `panel serve $entrypoint --port 8080 --address 0.0.0.0 --allow-websocket-origin=*` | 8080 |
| `gradio` | ociEnv, image | `python $entrypoint` (app binds `GRADIO_SERVER_PORT=8080`) | 8080 |
| `dash` | ociEnv, image | `gunicorn $module:server -b 0.0.0.0:8080` | 8080 |
| `voila` | ociEnv, image | `voila $entrypoint --port=8080 --no-browser --Voila.ip=0.0.0.0` | 8080 |
| `fastapi` | ociEnv, image | `uvicorn $module:app --host 0.0.0.0 --port 8080` | 8080 |
| `custom` | any | `spec.runtime.command` (required) | configurable |

The framework table lives in the operator (authoritative) and is mirrored read-only in the
API (`GET /frameworks`) so the UI/skill can render choices and validate.

---

## 6. Workload Model — How Apps Run as Pods

This section answers the central question: *how do pods fit the pack framework?*

### Reconcile pipeline (apps-operator)
For each `App`, the operator runs an ordered, idempotent pipeline (mirroring nebari-operator's
core→routing→tls→auth structure):

1. **Validate** — namespace is `nebari.dev/managed`; framework + source are coherent; owner set.
2. **Environment** (Python only) — ensure the pixi env is available:
   - For `source.type: ociEnv`, add an **init container** that pulls the OCI artifact (the
     Nebi-published pixi env) into a shared `emptyDir`/PVC and activates it. The main
     container runs inside that env.
   - Sets the `EnvironmentReady` condition.
3. **Workload** — create/update a **Deployment**:
   - **Static:** an nginx/caddy image serving content into the web root, sourced by
     `source.type`: `inline` (files carried in the CR, materialized as a ConfigMap-backed
     volume — best for small sites), `pvc` (mount an existing volume — best for larger sites),
     or `git` (init-container clone). **Local-file launches** (a directory with an
     `index.html`) are an *authoring convenience*: the API/MCP/UI bundles the uploaded files
     and renders them into the CR as `inline` (small) or a provisioned `pvc` (large) — see §12.
   - **Python (`ociEnv`):** a small **base runtime image** (python + pixi shim) + init
     container that (a) materializes the pixi env from OCI and (b) fetches app code; main
     container runs the framework command inside the env.
   - **Python (`image`):** run the prebuilt image directly (self-contained path).
   - Apply resources, env, replicas, probes (readiness on the listen port), security context
     (non-root, read-only FS where possible), and standard labels.
4. **Service** — a `ClusterIP` Service on the listen port.
5. **Routing/Auth/Landing** — emit a **`NebariApp`** owned by this `App`:
   ```yaml
   apiVersion: reconcilers.nebari.dev/v1
   kind: NebariApp
   metadata: { name: app-sales-dashboard, namespace: team-analytics, ownerReferences: [<App>] }
   spec:
     hostname: sales-dashboard.cluster.example.com   # from access.subdomain + cluster domain
     gateway: public                                  # or internal
     service: { name: app-sales-dashboard, port: 8080 }
     routing: { routes: [ { pathPrefix: "/" } ] }
     auth:
       enabled: true                                  # false if access.public
       provider: keycloak
       provisionClient: true                          # nebari-operator creates the OIDC client
       scopes: [openid, profile, email, groups]
       allowedGroups: ["analytics"]                   # maps from access.groups
     landingPage:
       enabled: true
       displayName: "Sales Dashboard"
       category: "Apps"
       icon: "<thumbnail or default>"
   ```
   The nebari-operator then provisions HTTPRoute + Certificate + SecurityPolicy + Keycloak
   client + landing-page tile.
6. **Status** — aggregate workload + NebariApp conditions; publish `status.url`, phase,
   replica counts, and a human-readable message.

### Ownership & garbage collection
The `App` owns the Deployment, Service, and `NebariApp` via `ownerReferences`. Deleting the
`App` (via API → CR delete, or `kubectl delete`) cascades automatically; the nebari-operator
tears down routing/cert/OIDC client.

### Why a CRD + operator (recap of the decision)
- **One contract, many producers.** UI/API/MCP/GitOps all just produce an `App`. No producer
  needs to know how to assemble Deployments, Services, routing, and OIDC clients.
- **Self-healing.** The reconcile loop converges drift; restarts/upgrades are safe.
- **GitHub is optional, not required.** The apps-api writes CRs directly via a ServiceAccount
  (dynamic, no git). GitOps/ArgoCD is an opt-in path for teams who want their apps in version
  control. Both write the *same* CR; the operator doesn't care who wrote it.
- **Matches the most mature pack** (`nebari-llm-serving-pack` = CRD + Go operator + UI).

---

## 7. Pixi Environments via Nebi (Soft Dependency)

Python apps need a Python environment. Nebi already manages **pixi** environments
("workspaces"), versions them, and **publishes them as OCI artifacts**. The Apps Pack consumes
that.

**Flow (Nebi present):**
1. A user (or agent) has a Nebi workspace, e.g. `team-analytics/ds-stack`, solved + published
   to `oci://quay.io/nebari/envs/team-analytics/ds-stack:v3`.
2. The launch form / MCP / API lists available environments by calling **Nebi's API**
   (`GET /workspaces`) — surfaced as `GET /environments` on apps-api.
3. The `App.spec.source.ociEnv.ref` points at the published artifact.
4. At pod start, an **init container** pulls and materializes the pixi env into a shared
   volume; the main container runs the framework command inside it.

**Soft-dependency behavior (Nebi absent):**
- **Static apps** work fully (no env needed).
- **Python apps** fall back to a **built-in minimal pixi path**: the operator accepts an inline
  `pixi.toml` (or a small set of pinned base envs shipped with the pack) and solves it in an
  init container using the pixi CLI. This is less powerful (no versioning/sharing/registry) but
  keeps the pack independently installable.
- The API advertises capability via `GET /capabilities` (`{ nebi: false, environments: "inline-only" }`)
  so the UI/skill adapt.

**Why OCI env over per-app image (the chosen approach):** fast iteration. An agent can change
app code and re-launch without a container build; the env artifact is shared and cached across
apps. (An optional `source.type: image` path remains for teams that want fully pinned,
self-contained apps — see §16 "Optional image build".)

---

## 8. Authentication & Authorization

### Identities
- **Browser users (UI + the apps themselves):** standard Nebari Keycloak SSO. The UI is a
  `NebariApp` with `auth.enabled: true`; each launched app is likewise gated by its own
  `NebariApp` `SecurityPolicy` (unless `access.public`).
- **The MCP server / CLI / agents:** **Keycloak device authorization flow (RFC 8628)**. The
  nebari-operator already supports provisioning a **public device-flow client**. The agent runs
  the MCP tool, the MCP returns a verification URL + code, the user approves in a browser, and
  the MCP receives tokens. Tokens are cached locally (keyring) and refreshed.
- **apps-api ↔ Kubernetes:** the API runs with a ServiceAccount + RBAC scoped to create/patch
  `App` CRs (and read derived resources for observability) in managed namespaces.

### Authorization model
- **Who can launch / manage an app:** enforced by apps-api using the caller's Keycloak groups.
  An app's `access.groups`/`access.users` plus an `owner` field define management rights.
  (We reuse the casbin-style group model already present in Nebi where convenient.)
- **Who can *view/use* a running app:** enforced at the gateway by the `NebariApp`
  `SecurityPolicy` (`allowedGroups`) — same mechanism every Nebari app uses. `public: true`
  disables it for anonymous apps.
- **Namespaces as tenancy boundary:** apps live in project/team namespaces. The API maps a
  user's groups → permitted namespaces.

### Token flow for "agent generates → user launches"
1. Agent scaffolds the app (skill), pushes code to git or stages a Nebi env.
2. User: *"Launch the sales dashboard as a Streamlit app using the ds-stack environment."*
3. MCP `launch_app` tool runs → if no valid token, returns a device-flow prompt → user
   approves → MCP calls `POST /apps` on apps-api with the bearer token.
4. apps-api validates the token + groups, writes the `App` CR, returns the (pending) app with
   its future URL. MCP reports status; `get_app_status` polls until `Running`.

---

## 9. The MCP Server (`apps-mcp`)

A **FastMCP** (Python) server running in-cluster as part of the pack, exposed as a `NebariApp`
(streamable HTTP). It is a **thin, well-described tool layer over apps-api** — it holds no
business logic of its own, so behavior stays consistent across UI/API/MCP.

### Tools
| Tool | Purpose | Maps to |
|---|---|---|
| `authenticate` | Start/refresh Keycloak device flow; return verification URL+code or confirm cached token. | Keycloak device endpoint |
| `list_environments` | List available pixi environments (from Nebi) the caller can use. | `GET /environments` |
| `list_frameworks` | List supported frameworks + their requirements. | `GET /frameworks` |
| `launch_app` | Create + launch an app from NL-resolved params (name, framework, source, env, access). | `POST /apps` |
| `list_apps` | List apps the caller can see (filter by namespace/owner/status). | `GET /apps` |
| `get_app` | Full spec + status + URL for one app. | `GET /apps/{id}` |
| `get_app_status` | Lightweight phase/replicas/url poll. | `GET /apps/{id}/status` |
| `get_app_logs` | Recent pod logs (optionally follow N lines). | `GET /apps/{id}/logs` |
| `update_app` | Patch an app (replicas, env, source ref, access). | `PATCH /apps/{id}` |
| `stop_app` / `start_app` | Scale to zero / back up. | `POST /apps/{id}:stop|start` |
| `remove_app` | Delete the app (cascades). | `DELETE /apps/{id}` |
| `describe_cluster` | Capabilities (Nebi present? gateways? domain?) so the agent picks valid options. | `GET /capabilities` |

### Design notes
- Tool descriptions are written for an LLM caller: each documents required vs. optional args,
  enumerates valid `framework`/`source.type` values, and explains how to resolve an
  environment from a natural-language hint (call `list_environments` first, match by name).
- `launch_app` is **idempotent on `(namespace, name)`**: re-launching updates rather than
  duplicating, so an agent retrying is safe.
- All tools return structured JSON the agent can reason over (status, url, conditions, next
  actions like "approve device login at <url>").

---

## 10. REST API (`apps-api`)

FastAPI, async SQLAlchemy (for app metadata/audit/observability cache), pydantic v2,
structlog, OIDC bearer auth (validates Keycloak tokens; in-cluster + external issuer URLs).

### Endpoints (v1)
```
# Capabilities & catalogs
GET    /capabilities                 # { nebi, gateways, clusterDomain, environments }
GET    /frameworks                   # supported frameworks + requirements
GET    /environments                 # pixi envs (proxied/cached from Nebi)

# App CRUD  (writes App CRs to the cluster)
GET    /apps                         # list (RBAC-filtered: namespace/owner/groups)
POST   /apps                         # create + launch  -> writes App CR
GET    /apps/{id}                    # full spec + status
PATCH  /apps/{id}                    # update spec (replicas, env, source, access)
DELETE /apps/{id}                    # delete (cascade)
POST   /apps/{id}:stop               # scale to zero
POST   /apps/{id}:start              # scale back up

# Observability
GET    /apps/{id}/status             # phase, replicas, url, conditions
GET    /apps/{id}/logs               # pod logs (query: lines, follow, container)
GET    /apps/{id}/events             # k8s events for the app's resources
GET    /apps/{id}/metrics            # cpu/mem (if metrics-server present)

# Auth
GET    /auth/device                  # initiate device flow (for MCP/CLI)
GET    /auth/me                      # current user + groups
```

### Request model (POST /apps) — ported & trimmed from jhub-apps
```jsonc
{
  "displayName": "Sales Dashboard",
  "description": "Q2 sales explorer",
  "framework": "streamlit",
  "namespace": "team-analytics",
  "source": {
    "type": "ociEnv",
    "ociEnv": {
      "ref": "oci://quay.io/nebari/envs/team-analytics/ds-stack:v3",
      "code": { "type": "git", "git": { "url": "...", "ref": "main", "subdir": "app" } },
      "entrypoint": "app.py"
    }
  },
  "runtime": { "env": [{ "name": "LOG_LEVEL", "value": "info" }], "replicas": 1 },
  "access": { "public": false, "groups": ["analytics"], "subdomain": "sales-dashboard" },
  "thumbnail": "data:image/png;base64,..."   // optional
}
```
The API validates against `/frameworks` + `/capabilities`, applies RBAC, then renders and
applies the `App` CR. The DB stores a denormalized copy + audit log; live status is read back
from the CR/cluster (the CR remains source of truth, the DB is a cache + history).

---

## 11. The UI (`apps-ui`)

React + TS + Vite + shadcn/ui + Tailwind v4 (your frontend-dev conventions), TanStack Query +
Jotai, Keycloak via the standard Nebari SSO. Exposed as a `NebariApp`.

### Screens
1. **App catalog / dashboard** — grid of app cards (thumbnail, name, framework, status badge,
   owner, URL). Filter by status/owner/namespace. This is the landing experience.
2. **Launch form** (the `jhub-apps`-style flow, minus JupyterHub):
   - Name, description, thumbnail.
   - **Framework** dropdown (from `/frameworks`).
   - **Source**: tabs for *Environment + code* (pixi/Nebi), *Prebuilt image*, *Git (static)*,
     *Inline/upload* (static). Environment dropdown from `/environments`; entrypoint field.
   - **Resources** (cpu/mem/replicas) and **env vars** (key-value editor).
   - **Access**: public toggle, groups/users selector, subdomain.
   - Submit → `POST /apps` → redirect to the app detail page (spawn-pending → running).
3. **App detail / observability** — status + conditions timeline, live URL, **logs viewer**
   (streamed), **events**, metrics (cpu/mem), and edit/stop/start/delete actions.
4. **Edit** — same form pre-populated (maps to `PATCH /apps/{id}`).

The UI is deliberately a thin client over apps-api (same authority as MCP), so the launch
semantics are identical whether a human uses the form or an agent uses NL.

---

## 12. The Skill — Scaffolding Compatible Apps

A Claude Code skill (`/new-nebari-app` or similar) that an agent invokes to **generate** an app
in the exact layout the pack expects, so "generate → launch" is frictionless. (Lives alongside
your existing `new-frontend` / `new-backend` skills.)

### What it does
- Asks/infers **static vs Python** and the **framework**.
- Scaffolds the directory layout + a **`nebari-app.yaml`** manifest (a thin, human-authored
  spec the API/MCP can consume directly — maps 1:1 to `App.spec`):
  ```yaml
  # nebari-app.yaml  — committed next to the app code
  displayName: "Sales Dashboard"
  framework: streamlit
  source:
    type: ociEnv
    ociEnv: { ref: "<nebi-env>", code: { type: git, git: { subdir: "." } }, entrypoint: "app.py" }
  runtime: { replicas: 1 }
  access: { public: false, groups: ["analytics"], subdomain: "sales-dashboard" }
  ```
- For **Python**: scaffolds `app.py` (framework-specific starter), a `pixi.toml` (so Nebi can
  solve + publish the env), and a `README`.
- For **static**: scaffolds a real `index.html` + assets and a `nebari-app.yaml` whose source
  points at the local content directory:
  ```yaml
  # nebari-app.yaml  — sits next to index.html
  displayName: "Docs Site"
  framework: static
  source:
    type: files          # authoring convenience: a local directory of real files
    files: { path: "." }  # dir containing index.html, relative to this manifest
  access: { public: true, subdomain: "docs-site" }
  ```
  On launch, the API/MCP/UI **bundles the referenced files** and renders them into the `App`
  CR as `source.type: inline` (small sites) or a provisioned `pvc` (large sites). So the author
  works with actual files, never hand-edited inline HTML; `inline`/`pvc`/`git` remain the
  on-cluster CR forms.
- Emits the **exact natural-language launch instruction** the user can hand to the MCP, e.g.:
  *"Launch the app in ./sales-dashboard using nebari-app.yaml."* — the MCP reads
  `nebari-app.yaml` and calls `launch_app`.

### Why a manifest file
It bridges the agent and the launcher: the agent writes code + `nebari-app.yaml`; the MCP/API
read that manifest so there's no ambiguity translating NL → `App.spec`. It's also the GitOps
artifact if the team commits it.

---

## 13. Observability

- **Status:** every `App` publishes phase + conditions + URL; surfaced in UI, API, MCP.
- **Logs:** apps-api streams pod logs (k8s API) → UI logs viewer + MCP `get_app_logs`.
- **Events:** k8s events for the app's Deployment/Pods/NebariApp aggregated per app.
- **Metrics:** cpu/mem from metrics-server (if installed); optional ServiceMonitor for
  Prometheus to scrape app + operator metrics.
- **Operator metrics:** reconcile counts, errors, durations (controller-runtime defaults).
- **Audit:** apps-api records who launched/changed/removed each app (DB), exposed in detail view.

---

## 14. Security Considerations

- **Pod hardening:** non-root, drop capabilities, read-only root FS where the framework allows,
  seccomp `RuntimeDefault`, resource limits required (defaults applied if omitted).
- **Network:** default-deny `NetworkPolicy` per app namespace; app pods reach only what they
  need (DNS, the OCI registry for env pull, declared egress).
- **Untrusted code:** apps run *user/agent-authored code*. Treat every app as untrusted:
  per-namespace tenancy, no cluster-admin tokens in app pods, no host mounts, OCI pulls
  restricted to allowed registries. Consider gVisor/Kata for stronger isolation (deferred).
- **Auth bypass paths:** only `access.public: true` apps skip SSO — flagged prominently in UI
  and require an explicit confirmation + (optionally) an admin-allowed group.
- **Secrets:** app env secrets via referenced k8s Secrets, never inlined in the CR; OIDC client
  secrets are operator-managed (nebari-operator) and mounted, not exposed via API.
- **MCP:** device-flow tokens scoped to the user's groups; the MCP cannot exceed the caller's
  RBAC because it always acts as the authenticated user against apps-api.

---

## 15. Packaging & Deployment

Follows the established pack convention (template: `nebari-llm-serving-pack`).

```
nebari-apps-pack/
  pack-metadata.yaml            # dashboard registration + nebariapp_integration: full
  charts/nebari-apps/
    Chart.yaml
    values.yaml                 # clusterDomain, gateways, keycloak, nebi.url, images, registries
    crds/
      app-crd.yaml              # apps.nebari.dev/v1alpha1 App
    templates/
      operator-*.yaml           # operator Deployment + RBAC + (optional) webhook
      api-deployment.yaml
      api-service.yaml
      api-nebariapp.yaml        # exposes apps-api (auth on)
      ui-deployment.yaml
      ui-service.yaml
      ui-nebariapp.yaml         # exposes apps-ui (landing-page tile = "Apps")
      mcp-deployment.yaml
      mcp-service.yaml
      mcp-nebariapp.yaml        # exposes apps-mcp (device-flow client)
      namespace.yaml
      _helpers.tpl
  operator/                     # Go / kubebuilder
    api/v1alpha1/app_types.go
    internal/controller/app_controller.go
    internal/controller/reconcilers/{validate,environment,workload,service,routing,status}/
    cmd/  Dockerfile  go.mod
  api/                          # FastAPI
    src/nebari_apps_api/  pyproject.toml  Dockerfile
  ui/                           # React + Vite
    src/  components.json  vite.config.ts  package.json  Dockerfile  nginx.conf
  mcp/                          # FastMCP
    src/nebari_apps_mcp/  pyproject.toml  Dockerfile
  skill/                        # the scaffolding skill
    SKILL.md  references/  assets/
  examples/                     # sample App CRs, ArgoCD Application
  docs/  README.md  LICENSE
```

- **Install:** Helm chart (or ArgoCD Application), parameterized with `clusterDomain`, gateway
  names/namespaces, `keycloak.*`, and `nebi.url` (optional — soft dependency).
- **Prereqs:** nebari-operator (for `NebariApp`), Envoy Gateway + AI Gateway, cert-manager
  issuer, Keycloak realm, a StorageClass, and an OCI registry. Nebi is **optional**.
- **CRD lifecycle:** ship the `App` CRD in `charts/crds/` (or a separate ArgoCD-managed source).

---

## 16. Open Questions & Future Work

- **Scale-to-zero / idle reaping.** v1 = fixed `replicas` + manual stop/start. Future: KEDA or
  Knative for true scale-to-zero on idle (`keepAlive: false`). Decide whether the operator owns
  this or delegates.
- **Optional image-build path.** `source.type: image` is specified but the *build pipeline*
  (turning code+pixi → image) is out of v1 scope. Could be a Tekton/Kaniko job triggered by the
  API. Needs design if/when prioritized.
- **Per-app custom domains** vs. subdomain-only — v1 is subdomain under cluster domain.
- **Sharing UX parity with jhub-apps** (revoke/re-grant flows) — model supports it; UI depth TBD.
- **App templates / marketplace** — a catalog of starter apps the UI/skill can clone.
- **Stronger sandboxing** (gVisor/Kata) for untrusted agent-generated code.
- **Multi-version envs / pinning** — how aggressively to pin `ociEnv.ref` (digest vs tag).
- **Resource quotas per namespace/group** — enforce launch limits.

---

## 17. Decisions Locked (from review)

| Decision | Choice | Rationale |
|---|---|---|
| Pod orchestration | **App CRD + Go operator** | One declarative contract for all producers; self-healing; GitHub optional (API writes CRs directly). |
| API / UI / MCP stack | **FastAPI + React + FastMCP (Python/TS)** | Reuse jhub-apps model + your frontend/backend skills; operator stays Go (matches nebari-operator). |
| Pixi env delivery | **Nebi OCI workspaces** (init-container pull) | Fast agent iteration; shared/cached envs; no per-launch build. |
| Nebi coupling | **Soft dependency** | Static apps + inline-pixi fallback work without Nebi; full env mgmt when present. |
| GitOps | **Optional, not required** | API writes CRs dynamically via ServiceAccount; ArgoCD path for teams who want version control. |
