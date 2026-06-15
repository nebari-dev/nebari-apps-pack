# Nebari Apps Pack — Implementation Plan

Companion to [`DESIGN.md`](./DESIGN.md). Phased, each phase ends with a usable increment.

## Guiding principles
- **The `App` CR is the contract.** Build it first; everything else produces or reconciles it.
- **Vertical slices.** Each phase delivers a thing you can demo, not a horizontal layer.
- **API is the single authority.** UI and MCP are thin clients over apps-api from the start.
- **Soft-depend on Nebi.** Static-app path must work before any pixi/Nebi integration lands.

---

## Phase 0 — Foundations & scaffolding
**Goal:** repo + CRD + a static app reconciles to a running pod behind Nebari SSO.
- Scaffold `nebari-apps-pack/` per DESIGN §15; `pack-metadata.yaml`, Helm chart skeleton.
- Define the **`App` CRD** (`apps.nebari.dev/v1alpha1`) — types in Go (kubebuilder) + generated CRD YAML.
- **apps-operator** MVP: reconcile `framework: static`, `source.type: inline|git` →
  Deployment(nginx) + Service + **`NebariApp`** (routing/auth/landing) + status.
- Local dev loop (k3d/minikube + Tilt; mirror `k8s-deploy` conventions).
- **Exit:** `kubectl apply` a static `App` → reach it at `https://<sub>.<cluster>` behind Keycloak.

## Phase 1 — apps-api + CRUD
**Goal:** create/manage apps over HTTP; CR is written by the API, not by hand.
- FastAPI service: OIDC bearer auth (Keycloak, split-horizon issuer), RBAC by group/namespace.
- `POST/GET/PATCH/DELETE /apps`, `:stop`/`:start`, `/frameworks`, `/capabilities`.
- App CR rendering + apply via k8s client; DB (async SQLAlchemy) for metadata cache + audit.
- Status read-back from CR; `/apps/{id}/status`.
- Expose apps-api as a `NebariApp`.
- **Exit:** launch + delete a static app entirely through the REST API.

## Phase 2 — Python apps + Nebi env delivery
**Goal:** Python frameworks run in pixi envs from Nebi OCI artifacts.
- Operator: `framework: streamlit|panel|gradio|dash|voila|fastapi|custom`; framework→command table.
- **Environment reconciler:** `source.type: ociEnv` → init container pulls Nebi-published pixi
  env into shared volume; main container runs framework command inside it; `EnvironmentReady`.
- Base runtime image (python + pixi shim).
- apps-api `GET /environments` (proxy/cache Nebi `GET /workspaces`); `/capabilities` reports `nebi`.
- **Inline-pixi fallback** (Nebi absent): solve an inline `pixi.toml` in an init container.
- **Exit:** launch a Streamlit app using a Nebi env via the API; and a Python app with no Nebi.

## Phase 3 — apps-ui
**Goal:** the jhub-apps-style form launcher, JupyterHub-free.
- React + Vite + shadcn/ui; Keycloak SSO; TanStack Query + Jotai.
- Catalog/dashboard, **launch form** (framework, source tabs, env dropdown, resources, env vars,
  access), app detail with **status + logs viewer + events + metrics**, edit/stop/start/delete.
- Expose as `NebariApp` (landing-page tile "Apps").
- **Exit:** a user launches + manages an app end-to-end from the browser.

## Phase 4 — apps-mcp
**Goal:** natural-language launch/manage from a coding agent.
- FastMCP server (streamable HTTP) exposed as a `NebariApp`.
- **Keycloak device flow** auth (`authenticate` tool; token cache/refresh).
- Tools: `list_environments`, `list_frameworks`, `launch_app`, `list_apps`, `get_app`,
  `get_app_status`, `get_app_logs`, `update_app`, `stop_app`/`start_app`, `remove_app`,
  `describe_cluster` — all thin wrappers over apps-api.
- LLM-oriented tool descriptions; `launch_app` idempotent on `(namespace, name)`.
- **Exit:** from Claude Code/Codex: "launch this Streamlit app with the ds-stack env" → running app.

## Phase 5 — the scaffolding skill
**Goal:** agents generate apps in the exact expected layout.
- Skill (`/new-nebari-app`): scaffold static + Python starters, `pixi.toml`, and a
  **`nebari-app.yaml`** manifest (1:1 with `App.spec`).
- Emits the NL launch instruction for the MCP; reads `nebari-app.yaml` on launch.
- **Exit:** agent generates an app, user says "launch it," MCP reads the manifest and deploys.

## Phase 6 — Observability, security, hardening
- Pod hardening (non-root, RO FS, seccomp, limits), default-deny NetworkPolicies, registry allowlist.
- Metrics (ServiceMonitor for operator + apps), events aggregation, audit surfacing.
- Public-app confirmation guardrails; secret handling via Secret refs.
- Docs: README, install guide, examples (sample `App` CRs + ArgoCD Application).
- **Exit:** install via Helm/ArgoCD on a clean cluster following the docs; security review passes.

---

## Cross-cutting workstreams
- **CI/CD:** image builds for operator/api/ui/mcp; chart lint; e2e against k3d (mirror other packs).
- **Versioning/release:** semver tags + chart publish to `oci://quay.io/nebari/charts` (pack convention).
- **Testing:** operator envtest + reconcile unit tests; api pytest; ui vitest; one e2e per framework.

## Sequencing notes
- Phases 0→1→2 are the critical path (CR → API → Python/Nebi). 3 (UI) and 4 (MCP) can run in
  **parallel** once Phase 2's API surface is stable — both are thin clients.
- Phase 5 (skill) depends on the `nebari-app.yaml` schema being frozen (end of Phase 1).
- Defer scale-to-zero and the image-build pipeline (DESIGN §16) unless prioritized.

## Risks
- **nebari-operator `NebariApp` contract drift** — pin the version; add a contract test.
- **Untrusted agent-generated code** — tenancy + hardening must land before any public exposure.
- **Nebi OCI env format** — confirm the artifact layout Nebi publishes and how pixi materializes it
  in an init container (validate early in Phase 2; it's the biggest unknown).
- **Keycloak device-flow client provisioning** — confirm nebari-operator exposes this for the MCP.
