# Silicofeller Quantum Studio — V2

**Professional EDA Platform for Superconducting Quantum Chip Design**

Quantum Studio V2 is a constraint-driven electronic design automation (EDA) tool that mirrors the professional quantum hardware workflow:

```
Architecture Design → Chip Topology → Physical Layout → Routing
    → Frequency Planning → DRC → EM Simulation → Fabrication Review → Tapeout
```

> **Production note:** All design outputs — chip generation, verification, materials, simulations — are
> sourced exclusively from the backend. There are no client-side mock or fallback generators.
> The backend **must** be running for the designer to work.

---

## V2 Architecture

```
User Input (Prompt / Schematic Editor / Constraints JSON)
         │
         ▼
DesignConstraints          ← chip_size, topology, substrate, metal,
         │                    frequency band, fabrication rules
         ▼
build_graph_from_constraints()
         │
         ▼
DesignGraph                ← typed nodes: QubitNode, CouplerNode,
         │                    ResonatorNode, FeedlineNode, LaunchpadNode
         ▼
GraphValidator.validate()  ← structural checks before any physics
         │
         ▼
FrequencyPlanner.plan()    ← Schneider CPW ε_eff, IBM A/B coloring,
         │                    EJ/EC (Koch transmon), dispersive detuning
         ▼
place_qubits()             ← Kamada-Kawai graph layout → mm coordinates
         │
         ▼
route_design()             ← CPWRouter + ResonatorRouter + FeedlineRouter
         │
         ▼
run_full_drc()             ← 4-domain DRC (geometry, frequency,
         │                    fabrication, connectivity)
         ▼
generate_qiskit_code()     ← Qiskit Metal Python (TransmonPocket,
         │                    RouteMeander, LaunchpadWirebond)
         ▼
ExportEngine.export_all()  ← JSON, QCLang (.qc), GDS-II ASCII,
                              SVG, DXF, PDF report
```

---

## Quick Start

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Python | 3.10 – 3.11 | 3.12 not yet tested |
| Node.js | 18+ | LTS recommended |
| npm | 8+ | Comes with Node.js |

> **Windows note:** Use `python` (not `py`) if you installed Python from python.org. Avoid the Microsoft Store alias.

---

### 1 — Backend Setup (FastAPI)

```powershell
# From the project root:
cd backend

# Create virtual env + install all dependencies (one-time)
python setup.py

# Copy environment file (one-time)
copy .env.example .env

# Start the API server
.venv\Scripts\python run.py
```

**macOS / Linux:**
```bash
cd backend
python3 setup.py
cp .env.example .env
.venv/bin/python run.py
```

- API base URL: `http://localhost:5000`
- Swagger docs: `http://localhost:5000/docs`
- ReDoc: `http://localhost:5000/redoc`

> **No database setup needed** — SQLite is used by default (dev.db created automatically).

---

### 2 — Frontend Setup (React / TanStack Start)

Open a **second terminal**:

```powershell
# From the project root:
cd frontend

# Install Node dependencies (one-time, or after package.json changes)
npm install

# Start the dev server
npm run dev
```

- App URL: `http://localhost:5173`

> The frontend automatically talks to the backend at `http://localhost:5000`.  
> To change this, set `VITE_BACKEND_URL` in `frontend/.env.local`.

> **Important:** The backend must be running before you use the designer or verification features.
> If the backend is unreachable, the app will show a proper error in the UI — it will **not** generate
> fake/simulated chip data.

---

### 3 — Running Both Together (Summary)

| Terminal | Command | URL |
|----------|---------|-----|
| Terminal 1 | `cd backend && .venv\Scripts\python run.py` | http://localhost:5000 |
| Terminal 2 | `cd frontend && npm run dev` | http://localhost:5173 |

---

### Docker (Production — All-in-one)

```bash
# Set a secure secret key (required)
$env:SECRET_KEY="your-secret-minimum-32-chars"   # PowerShell
# or
export SECRET_KEY="your-secret-minimum-32-chars"  # bash

docker-compose up --build
```

Services started by Docker:
- PostgreSQL on port `5432`
- Redis on port `6379`
- Backend API on port `5000`
- Frontend on port `3000` → `http://localhost:3000`

---

## Backend Structure (V2)

```
backend/
├── setup.py                  ← Run this first: creates .venv + installs deps
├── run.py                    ← Start dev server (uvicorn on port 5000)
├── requirements.txt          ← Python dependencies
├── .env.example              ← Copy to .env and edit
└── app/
    ├── main.py               ← FastAPI app entry point
    ├── config.py             ← Settings (reads from .env)
    ├── database.py           ← SQLAlchemy async engine (SQLite dev / Postgres prod)
    ├── auth.py               ← JWT helpers
    ├── models.py             ← SQLAlchemy ORM models
    ├── core/
    │   └── design_graph/     ← V2 FOUNDATION — typed design graph
    │       ├── node.py       — QubitNode, CouplerNode, ResonatorNode…
    │       ├── edge.py       — DesignEdge, EdgeKind
    │       ├── graph.py      — DesignGraph (single source of truth)
    │       ├── validator.py  — Structural graph validation
    │       └── serializer.py — graph ↔ JSON
    ├── constraints/          ← CONSTRAINT-DRIVEN DESIGN
    │   ├── constraints.py    — DesignConstraints, FabConstraints, FreqConstraints
    │   └── builder.py        — build_graph_from_constraints()
    ├── drc/                  ← 4-DOMAIN DRC ENGINE
    │   ├── geometry_drc.py
    │   ├── frequency_drc.py
    │   ├── fabrication_drc.py
    │   ├── connectivity_drc.py
    │   ├── report.py
    │   └── runner.py         — run_full_drc()
    ├── routing/              ← AUTO-ROUTING ENGINE
    │   ├── cpw_router.py
    │   ├── resonator_router.py
    │   ├── feedline_router.py
    │   ├── pipeline.py       — route_design() orchestrator
    │   └── result.py
    ├── exports/              ← MULTI-FORMAT EXPORT
    │   ├── formats.py        — JSON, QCLang, GDS-II ASCII, SVG, DXF, PDF
    │   └── engine.py         — ExportEngine
    ├── services/
    │   ├── design_pipeline.py  ← V2 MAIN ORCHESTRATOR
    │   ├── materials.py
    │   ├── chip_generator.py
    │   ├── verification.py
    │   ├── tapeout.py
    │   └── physics/
    │       ├── frequency_planner.py
    │       ├── topology_router.py
    │       ├── drc.py
    │       └── ml_intent.py
    ├── routers/
    │   ├── design.py         ← /api/design/* (V2)
    │   ├── generate.py       — /health, /generate (V1 compat)
    │   ├── projects.py       — /api/projects/*
    │   ├── qclang.py         — /api/qclang/*
    │   ├── verification.py   — /api/verification/*
    │   ├── simulations.py    — /api/simulations/*
    │   ├── tapeout.py        — /api/tapeout/*
    │   ├── materials.py      — /api/materials
    │   ├── claude.py         — /api/claude/chat
    │   └── auth.py           — /api/auth/*
    └── qclang/               ← QCLANG COMPILER
        ├── lexer.py
        ├── parser.py
        ├── validator.py
        ├── compiler.py
        └── full/             — Full .qcl dialect
```

---

## Frontend Structure

```
frontend/
├── package.json
├── vite.config.ts
└── src/
    ├── routes/
    │   ├── index.tsx             ← Landing page (public, separate theme)
    │   ├── _app.tsx              ← Authenticated app shell (sidebar + header)
    │   ├── _auth.tsx             ← Auth layout wrapper
    │   ├── _app/
    │   │   ├── dashboard.tsx     ← Workspace home — real stats from backend
    │   │   ├── designer.tsx      ← AI chip designer (main feature)
    │   │   ├── projects.tsx      ← Project manager — CRUD via /api/projects
    │   │   ├── schematic-editor.tsx ← Visual transmon schematic editor
    │   │   ├── layout-viewer.tsx ← Physical layout visualiser (GDS view)
    │   │   ├── verification.tsx  ← DRC + frequency verification
    │   │   ├── simulations.tsx   ← Simulation runner
    │   │   ├── results.tsx       ← Results viewer
    │   │   ├── physics-analysis.tsx
    │   │   ├── fault-tolerance.tsx
    │   │   └── component-library.tsx
    │   └── _auth/
    │       ├── sign-in.tsx       ← Login → POST /api/auth/token
    │       ├── sign-up.tsx       ← Register → POST /api/auth/register
    │       └── forgot-password.tsx
    └── lib/
        ├── api/
        │   └── backend.ts        ← All backend API calls (throws on error — no mocks)
        ├── auth/                 ← Auth context / hooks
        ├── design-context.tsx    ← Global designer state (sessions named "Untitled Project N")
        └── project-context.tsx   ← Project state
```

---

## API Endpoints

### Design Pipeline (V2)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/design/generate` | **Full V2 pipeline** — constraints → graph → freq plan → placement → routing → DRC → code → exports |
| `POST` | `/api/design/generate-from-graph` | Run V2 pipeline from schematic editor graph JSON |
| `POST` | `/api/design/validate` | Structural graph validation (fast, no physics) |
| `POST` | `/api/design/route` | Auto-routing from placement dict |
| `POST` | `/api/design/drc` | Advanced 4-domain DRC |
| `POST` | `/api/design/export` | Single-format export (json/qclang/gds/svg/dxf/pdf) |
| `POST` | `/api/design/export-all` | All formats at once |
| `POST` | `/api/design/frequency-plan` | Constraint-driven frequency planning |
| `GET`  | `/api/design/topologies` | Supported topologies with metadata |

### Auth

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/register` | Register new user → returns JWT token |
| `POST` | `/api/auth/token` | Login (OAuth2 form) → returns JWT token |
| `GET`  | `/api/auth/me` | Get current user (requires token) |

### Projects

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/projects` | List all projects (authenticated) |
| `POST` | `/api/projects` | Create project |
| `PATCH` | `/api/projects/{id}` | Update project |
| `DELETE` | `/api/projects/{id}` | Delete project |
| `POST` | `/api/projects/{id}/save-design` | Save design payload to project |

### Simulations

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/simulations` | List user's simulations |
| `POST` | `/api/simulations` | Create simulation record |
| `POST` | `/api/simulations/{id}/run` | Run physics analysis |

### Verification

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/verification/run` | Run DRC + frequency check and save report |
| `POST` | `/api/verification/check` | Stateless verification (no DB save) |
| `GET`  | `/api/verification/project/{id}` | Get all reports for a project |

### Legacy (V1 — still works)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | System health check |
| `POST` | `/generate` | Prompt → chip design |
| `POST` | `/api/generate/frequency-plan` | Standalone frequency plan |
| `POST` | `/api/generate/placement` | Standalone KK placement |
| `POST` | `/api/generate/drc` | V1 DRC |
| `POST` | `/api/generate/netlist` | Connectivity netlist |
| `POST` | `/api/generate/metal-code` | Qiskit Metal from editor JSON |
| `POST` | `/api/qclang/parse` | Parse QCLang → AST |
| `POST` | `/api/qclang/compile` | Compile QCLang → design |
| `GET`  | `/api/materials` | List substrates + metals |
| `POST` | `/api/claude/chat` | AI assistant chat |
| `POST` | `/api/tapeout/generate` | Generate tapeout package |

Full interactive docs: `http://localhost:5000/docs`

---

## Data Source Policy

**All user-facing outputs come exclusively from the backend.** There are no client-side data generators.

| Function | Behavior when backend is unavailable |
|----------|--------------------------------------|
| `generateChip()` | Throws → designer shows `❌ Synthesis failed: …` in chat |
| `runVerification()` | Throws → verification page shows error |
| `fetchMaterials()` | Throws → material selector shows unavailable state |
| `fetchSimulations()` | Throws → dashboard shows empty simulations |
| `fetchHealth()` | Returns `{ status: "offline" }` — safe indicator only |
| `askClaude()` | Returns a "backend offline" message — informational only |
| `getQCLangTemplates()` | Returns `[]` — templates are optional |

---

## Environment Variables

### Backend (`backend/.env`)

```env
# Database — SQLite (default, no install needed)
DATABASE_URL=sqlite+aiosqlite:///./dev.db
SYNC_DATABASE_URL=sqlite:///./dev.db

# Auth
SECRET_KEY=dev-secret-key-change-in-production-minimum-32-chars
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=10080

# CORS — add your frontend port here
CORS_ORIGINS=http://localhost:3000,http://localhost:5173,http://localhost:5174,http://localhost:8080

# App
APP_ENV=development
MAX_QUBITS=256

# Optional — AI assistant (falls back to rule-based if empty)
# ANTHROPIC_API_KEY=sk-ant-...
```

### Frontend (`frontend/.env.local`) — optional overrides

```env
VITE_BACKEND_URL=http://localhost:5000
```

> The frontend works **without** a `.env.local` — it defaults to `http://localhost:5000`.

---

## Running Tests

```powershell
cd backend

# V2 architecture tests (8 tests)
.venv\Scripts\python check_v2.py

# V1 integration / smoke tests (7 tests)
.venv\Scripts\python smoke_test.py
```

**macOS / Linux:**
```bash
.venv/bin/python check_v2.py
.venv/bin/python smoke_test.py
```

---

## Demo Accounts

When the backend is running, register any account via `/api/auth/register` or the Sign Up page.

| Role | Email | Password |
|------|-------|----------|
| Admin | `admin@silicofeller.com` | any (register first) |

> **No guest / offline mode.** The backend must be running for design functionality to work.

---

## Supported Topologies

| Key | Label | IBM Name | Max Degree |
|-----|-------|----------|-----------|
| `grid` | Grid | Surface Code basis | 4 |
| `heavy_hex` | Heavy Hex | Falcon / Eagle / Heron | 3 |
| `line` | Linear Chain | Test chips | 2 |
| `ring` | Ring | Research | 2 |
| `star` | Star | Research | N-1 |
| `all-to-all` | All-to-All | Small research | N-1 |

## Supported Materials

**Substrates:** `silicon` (ε_r=11.45), `sapphire` (ε_r=9.3), `silicon_nitride` (ε_r=7.5)

**Metals:** `aluminum` (Tc=1.2 K), `niobium` (Tc=9.2 K), `tantalum` (Tc=4.5 K), `nbtin` (Tc=15 K)

Material data is served from `GET /api/materials` — not hardcoded in the frontend.

---

## Troubleshooting

### Backend won't start

| Error | Fix |
|-------|-----|
| `python: command not found` | Install Python 3.10+ from python.org |
| `ModuleNotFoundError` | Run `python setup.py` again from `backend/` |
| `Address already in use :5000` | Kill the process on port 5000: `netstat -ano \| findstr :5000` |
| `.env not found` | Copy `backend/.env.example` to `backend/.env` |

### Frontend won't start

| Error | Fix |
|-------|-----|
| `node_modules not found` | Run `npm install` in `frontend/` |
| Port conflict | Vite auto-picks next port; check terminal output |
| API calls fail | Make sure backend is running on port 5000 |

### Backend is offline

When the backend is not running:
- The designer shows an error message in the chat — it does **not** produce fake chip data.
- The verification page shows an API error — it does **not** produce fake DRC results.
- The materials dropdown will be unavailable — it does **not** show hardcoded fallback materials.
- The dashboard shows `0` for all stats and an empty activity feed.

Start the backend with `.venv\Scripts\python run.py` (Windows) or `.venv/bin/python run.py` (macOS/Linux).

---

## V2 Design Graph

```python
from app.core.design_graph import (
    DesignGraph, DesignEdge, EdgeKind,
    QubitNode, CouplerNode, ResonatorNode, FeedlineNode, LaunchpadNode,
)

g = DesignGraph(chip_name="MyChip", topology="heavy_hex",
                substrate="silicon", metal="aluminum")

q1 = QubitNode(id="Q1", frequency_ghz=4.9, group="A")
q2 = QubitNode(id="Q2", frequency_ghz=5.1, group="B")
c1 = CouplerNode(id="C1", qubit_a_id="Q1", qubit_b_id="Q2", strength_mhz=10.0)
r1 = ResonatorNode(id="RO_Q1", target_qubit_id="Q1", frequency_ghz=6.4)

for node in [q1, q2, c1, r1]:
    g.add_node(node)

g.add_edge(DesignEdge("Q1", "C1", EdgeKind.COUPLING))
g.add_edge(DesignEdge("C1", "Q2", EdgeKind.COUPLING))
g.add_edge(DesignEdge("Q1", "RO_Q1", EdgeKind.READOUT))

print(g.stats())
```

---

## QCLang

```
chip HeavyHex7Q
  variable substrate = "silicon"
  variable metal = "niobium"

  qubit Q1 type=transmon frequency=4.9
  qubit Q2 type=transmon frequency=5.1
  qubit Q3 type=transmon frequency=4.92

  coupler C1 connect(Q1,Q2)
  coupler C2 connect(Q2,Q3)

  readout RO_Q1 connect(Q1)
  readout RO_Q2 connect(Q2)
end
```

Compile: `POST /api/qclang/compile` → returns full `GenerateResponse` with Qiskit Metal code.
