"""Persistent-worker Qiskit Metal rendering service."""
from __future__ import annotations

import logging
import multiprocessing
import threading
import time
from queue import Empty
from typing import Dict, Optional

from app.core.editor_models import (
    ComponentPreview, DesignDocument, RenderResult, RouteRender,
    ValidationIssue, ValidationResult, ViewBox,
)

log = logging.getLogger(__name__)

WORKER_WARMUP_TIMEOUT = 60
COMPONENT_RENDER_TIMEOUT = 30
DESIGN_RENDER_TIMEOUT = 60


# ── Geometry helpers ──────────────────────────────────────────────────────────

def _make_default_connection_pads(cls: type) -> dict:
    default_opts = getattr(cls, "default_options", {})
    if "_default_connection_pads" not in default_opts:
        return {}
    base = dict(default_opts["_default_connection_pads"])
    if "connector_location" in base:
        base.pop("connector_location", None)
        return {"readout": {**base, "connector_location": "0"}, "bus_01": {**base, "connector_location": "180"}, "bus_02": {**base, "connector_location": "90"}}
    if "loc_W" in base and "loc_H" in base:
        return {"a": {**base, "loc_W": "+1", "loc_H": "+1"}, "b": {**base, "loc_W": "-1", "loc_H": "+1"}, "c": {**base, "loc_W": "+1", "loc_H": "-1"}, "d": {**base, "loc_W": "-1", "loc_H": "-1"}}
    return {name: dict(base) for name in ("a", "b", "c", "d")}


def _geom_to_svg(geom, color: str, scale: float, out: list) -> None:
    gtype = geom.geom_type
    if gtype == "Polygon":
        d = _poly_d(geom, scale)
        if d:
            out.append(f'<path d="{d}" fill="{color}" fill-opacity="0.85" stroke="none"/>')
    elif gtype in ("MultiPolygon", "GeometryCollection"):
        for g in geom.geoms:
            _geom_to_svg(g, color, scale, out)
    elif gtype == "LineString":
        coords = list(geom.coords)
        if len(coords) >= 2:
            pts = " ".join(f"{x*scale:.1f},{y*scale:.1f}" for x, y in coords)
            out.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="10" stroke-linecap="round"/>')
    elif gtype == "MultiLineString":
        for g in geom.geoms:
            _geom_to_svg(g, color, scale, out)


def _poly_d(poly, scale: float) -> str:
    if poly.is_empty:
        return ""
    def ring(coords):
        pts = [(x*scale, y*scale) for x, y in coords]
        if len(pts) < 2:
            return ""
        d = f"M {pts[0][0]:.1f} {pts[0][1]:.1f}"
        for x, y in pts[1:]:
            d += f" L {x:.1f} {y:.1f}"
        return d + " Z"
    parts = [ring(poly.exterior.coords)]
    for interior in poly.interiors:
        parts.append(ring(interior.coords))
    return " ".join(p for p in parts if p)


def _placeholder_svg(component_id: str) -> str:
    label = component_id[:12]
    return (f'<rect x="-280" y="-180" width="560" height="360" rx="20" fill="#1e3a5f" '
            f'fill-opacity="0.15" stroke="#5B9BD5" stroke-width="8"/>'
            f'<text x="0" y="8" text-anchor="middle" font-size="48" font-family="monospace" '
            f'fill="#5B9BD5" font-weight="bold">{label}</text>')


# ── Worker functions (run inside persistent worker process) ───────────────────

def _do_component_preview(component_id, module_path, options, designs_mod, class_map, importlib_mod):
    cls = class_map.get(component_id)
    if cls is None:
        return {"fragment": "", "vb": [-500, -500, 1000, 1000]}

    design = designs_mod.DesignPlanar(enable_renderers=False)
    design.overwrite_enabled = True

    clean = {k: v for k, v in options.items() if k not in ("pos_x", "pos_y", "orientation")}
    clean["pos_x"] = "0mm"
    clean["pos_y"] = "0mm"
    if "connection_pads" not in clean:
        pc = _make_default_connection_pads(cls)
        if pc:
            clean["connection_pads"] = pc

    instance = cls(design, "preview", options=clean)
    design.rebuild()

    tables = design.qgeometry.tables
    if not any(len(gdf) > 0 for gdf in tables.values()):
        try:
            instance.rebuild()
        except Exception:
            pass

    MM = 1000.0
    COLORS = {"poly": "#5B9BD5", "path": "#2E5FA3", "junction": "#D4820A"}
    cid = instance.id
    bounds, paths = [], []

    for tname, gdf in tables.items():
        if gdf is None or len(gdf) == 0:
            continue
        color = COLORS.get(tname, "#5B9BD5")
        rows = gdf[gdf["component"] == cid] if "component" in gdf.columns else gdf
        for _, row in rows.iterrows():
            g = row.get("geometry")
            if g is None or g.is_empty:
                continue
            bounds.append(g.bounds)
            _geom_to_svg(g, color, MM, paths)

    if not paths or not bounds:
        return {"fragment": "", "vb": [-500, -500, 1000, 1000]}

    xmin = min(b[0] for b in bounds) * MM
    ymin = min(b[1] for b in bounds) * MM
    xmax = max(b[2] for b in bounds) * MM
    ymax = max(b[3] for b in bounds) * MM
    pad = max((xmax - xmin) * 0.1, (ymax - ymin) * 0.1, 20)
    return {"fragment": "\n".join(paths), "vb": [xmin-pad, ymin-pad, (xmax-xmin)+2*pad, (ymax-ymin)+2*pad]}


def _do_full_design(graph, designs_mod, class_map):
    design = designs_mod.DesignPlanar(enable_renderers=False)
    design.overwrite_enabled = True

    _EXCLUDE = frozenset({"connection_pads", "pos_x", "pos_y", "orientation", "chip", "layer"})
    inst_id_map: dict[str, int] = {}

    for comp in graph["components"]:
        cls = class_map.get(comp["componentId"])
        if cls is None:
            log.warning("Unknown component: %s", comp["componentId"])
            continue
        opts = {k: v for k, v in comp.get("options", {}).items() if k not in _EXCLUDE}
        pos = comp.get("position", {})
        opts["pos_x"] = f"{pos.get('x', 0)}mm"
        opts["pos_y"] = f"{pos.get('y', 0)}mm"
        if comp.get("rotation"):
            opts["orientation"] = str(comp["rotation"])
        ep = opts.get("connection_pads")
        if not isinstance(ep, dict) or not ep or any(not isinstance(v, dict) for v in ep.values()):
            pc = _make_default_connection_pads(cls)
            if pc:
                opts["connection_pads"] = pc
            else:
                opts.pop("connection_pads", None)
        try:
            inst = cls(design, comp["instanceName"], options=opts)
            inst_id_map[comp["instanceName"]] = inst.id
        except Exception as exc:
            log.warning("Could not place %s: %s", comp["instanceName"], exc)

    route_id_map: dict[str, int] = {}
    for conn in graph["connections"]:
        route_cls = class_map.get(conn["routeComponentId"])
        if route_cls is None:
            log.warning("Unknown route: %s", conn["routeComponentId"])
            continue
        opts = dict(conn.get("routeOverrides", {}))
        opts["pin_inputs"] = {
            "start_pin": {"component": conn["sourceComponentName"], "pin": conn["sourcePinName"]},
            "end_pin":   {"component": conn["targetComponentName"], "pin": conn["targetPinName"]},
        }
        rname = f"route_{conn['id'][:8]}"
        try:
            ri = route_cls(design, rname, options=opts)
            route_id_map[conn["id"]] = ri.id
        except Exception as exc:
            log.warning("Could not create route %s: %s", conn["id"], exc)

    design.rebuild()

    MM = 1000.0
    COLORS = {"poly": "#5B9BD5", "path": "#3a7abf", "junction": "#D4820A"}
    RCOLS  = {"poly": "#2E5FA3", "path": "#2E5FA3"}
    tables = design.qgeometry.tables
    bounds: list = []
    comp_svg: list[str] = []
    route_svgs: dict[str, list[str]] = {cid: [] for cid in route_id_map}

    for tname, gdf in tables.items():
        if gdf is None or len(gdf) == 0:
            continue
        color  = COLORS.get(tname, "#5B9BD5")
        rcolor = RCOLS.get(tname, "#2E5FA3")
        for _, row in gdf.iterrows():
            g = row.get("geometry")
            if g is None or g.is_empty:
                continue
            cnum = row.get("component")
            bounds.append(g.bounds)
            matched = next((cid for cid, rid in route_id_map.items() if cnum == rid), None)
            if matched is not None:
                _geom_to_svg(g, rcolor, MM, route_svgs[matched])
            else:
                _geom_to_svg(g, color, MM, comp_svg)

    if not bounds:
        return {"svg": "", "vb": [-4500, -3000, 9000, 6000], "routes": {}}

    xmin = min(b[0] for b in bounds) * MM
    ymin = min(b[1] for b in bounds) * MM
    xmax = max(b[2] for b in bounds) * MM
    ymax = max(b[3] for b in bounds) * MM
    pad = max((xmax - xmin) * 0.08, (ymax - ymin) * 0.08, 200)

    return {
        "svg": "\n".join(comp_svg),
        "vb":  [xmin-pad, ymin-pad, (xmax-xmin)+2*pad, (ymax-ymin)+2*pad],
        "routes": {cid: "\n".join(svgs) for cid, svgs in route_svgs.items()},
    }


# ── Persistent worker process ─────────────────────────────────────────────────

def _worker_process(req_q: multiprocessing.Queue, res_q: multiprocessing.Queue) -> None:
    import os
    os.environ["QISKIT_METAL_HEADLESS"] = "1"
    os.environ["MPLBACKEND"] = "Agg"

    try:
        import importlib, inspect, pkgutil
        import qiskit_metal.qlibrary as _qlibrary
        from qiskit_metal import designs as _designs
        from qiskit_metal.qlibrary.core import QComponent as _QComponent

        _CLASS_MAP: dict[str, type] = {}
        for _, modname, _ in pkgutil.walk_packages(path=_qlibrary.__path__, prefix=_qlibrary.__name__ + ".", onerror=lambda _: None):
            try:
                mod = importlib.import_module(modname)
            except Exception:
                continue
            for _, cls in inspect.getmembers(mod, inspect.isclass):
                if issubclass(cls, _QComponent) and cls is not _QComponent and cls.__module__ == modname:
                    _CLASS_MAP[cls.__name__] = cls

        res_q.put({"type": "ready", "classes": len(_CLASS_MAP)})
    except Exception:
        import traceback
        res_q.put({"type": "error", "error": traceback.format_exc(limit=6)})
        return

    while True:
        try:
            job = req_q.get(timeout=300)
        except Exception:
            continue

        if job.get("type") == "stop":
            break

        job_id = job.get("id", "")
        try:
            jtype = job["type"]
            if jtype == "component_preview":
                result = _do_component_preview(job["component_id"], job["module"], job["params"], _designs, _CLASS_MAP, importlib)
            elif jtype == "full_design":
                result = _do_full_design(job["graph"], _designs, _CLASS_MAP)
            else:
                result = {"error": f"unknown job type: {jtype}"}
        except Exception:
            import traceback
            result = {"error": traceback.format_exc(limit=8)}

        result["id"] = job_id
        res_q.put(result)


# ── Worker manager (singleton) ────────────────────────────────────────────────

class _WorkerManager:
    def __init__(self) -> None:
        self._req:  "multiprocessing.Queue | None" = None
        self._res:  "multiprocessing.Queue | None" = None
        self._proc: "multiprocessing.Process | None" = None
        self._lock     = threading.Lock()
        self._ready    = False
        self._job_lock = threading.Lock()

    def _start(self) -> bool:
        self._req  = multiprocessing.Queue()
        self._res  = multiprocessing.Queue()
        self._proc = multiprocessing.Process(target=_worker_process, args=(self._req, self._res), daemon=True)
        self._proc.start()
        log.info("Persistent render worker starting (pid=%d) …", self._proc.pid)
        try:
            msg = self._res.get(timeout=WORKER_WARMUP_TIMEOUT)
            if msg.get("type") == "ready":
                log.info("Render worker ready — %d component classes loaded.", msg.get("classes", 0))
                self._ready = True
                return True
            log.error("Render worker failed: %s", msg.get("error", ""))
            return False
        except Exception:
            log.error("Render worker did not respond in %ds.", WORKER_WARMUP_TIMEOUT)
            return False

    def _ensure(self) -> bool:
        with self._lock:
            if self._proc is None or not self._proc.is_alive() or not self._ready:
                return self._start()
            return True

    def call(self, job: dict, timeout: int) -> dict:
        import uuid
        if not self._ensure():
            return {"error": "Render worker unavailable."}
        job_id = uuid.uuid4().hex
        job["id"] = job_id
        with self._job_lock:
            self._req.put(job)
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                try:
                    result = self._res.get(timeout=min(2.0, remaining))
                    if result.get("id") == job_id:
                        return result
                    self._res.put(result)
                except Empty:
                    pass
                if not self._proc.is_alive():
                    self._ready = False
                    return {"error": "Render worker crashed."}
        return {"error": f"Render timed out after {timeout}s."}


_manager = _WorkerManager()


def warmup_worker() -> None:
    _manager._ensure()


# ── RenderService ─────────────────────────────────────────────────────────────

class RenderService:

    def render_component_preview(self, component_id: str, params: Optional[Dict[str, object]] = None) -> ComponentPreview:
        from app.services.component_registry import component_registry_service
        summary = component_registry_service.get_component(component_id)
        if summary is None:
            log.warning("Preview requested for unknown component %s. Returning placeholder.", component_id)
            return ComponentPreview(id=component_id, svg=_placeholder_svg(component_id), viewBox=ViewBox(x=-300, y=-300, w=600, h=600), units="um")

        result = _manager.call({"type": "component_preview", "component_id": component_id, "module": summary.module, "params": params or {}}, timeout=COMPONENT_RENDER_TIMEOUT)

        if result.get("error"):
            log.warning("Preview failed for %s: %s", component_id, result["error"])
            return ComponentPreview(id=component_id, svg=_placeholder_svg(component_id), viewBox=ViewBox(x=-300, y=-300, w=600, h=600), units="um")

        svg = str(result.get("fragment", ""))
        raw = result.get("vb", [-500, -500, 1000, 1000])
        vb  = ViewBox(x=float(raw[0]), y=float(raw[1]), w=float(raw[2]), h=float(raw[3])) if isinstance(raw, list) and len(raw) == 4 else ViewBox(x=-500, y=-500, w=1000, h=1000)

        if not svg.strip():
            svg = _placeholder_svg(component_id)
            vb  = ViewBox(x=-300, y=-300, w=600, h=600)

        return ComponentPreview(id=component_id, svg=svg, viewBox=vb, units="um")

    def render_design(self, design: DesignDocument) -> RenderResult:
        if not design.placements:
            return RenderResult(svg="", viewBox=ViewBox(x=-4500, y=-3000, w=9000, h=6000), units="um", layers=[], routes=[])

        _EXCLUDE = frozenset({"connection_pads", "pos_x", "pos_y", "orientation", "chip", "layer"})
        placement_names = {p.id: p.name for p in design.placements}
        graph = {
            "components": [
                {"instanceName": p.name, "componentId": p.componentId,
                 "options": {k: str(v) for k, v in p.params.items() if k not in _EXCLUDE},
                 "position": {"x": p.x, "y": p.y}, "rotation": p.rotation}
                for p in design.placements
            ],
            "connections": [
                {"id": c.id,
                 "sourceComponentName": placement_names.get(c.from_.placementId, c.from_.placementId),
                 "sourcePinName": c.from_.pinName,
                 "targetComponentName": placement_names.get(c.to.placementId, c.to.placementId),
                 "targetPinName": c.to.pinName,
                 "routeComponentId": c.routeComponentId or "RouteMeander",
                 "routeOverrides": {k: str(v) for k, v in c.routeOverrides.items()}}
                for c in design.connections
            ],
        }

        result = _manager.call({"type": "full_design", "graph": graph}, timeout=DESIGN_RENDER_TIMEOUT)

        if result.get("error"):
            log.warning("Design render failed: %s", result["error"])
            return RenderResult(svg="", viewBox=ViewBox(x=-4500, y=-3000, w=9000, h=6000), units="um", layers=[], routes=[])

        svg = result.get("svg", "")
        raw = result.get("vb", [-4500, -3000, 9000, 6000])
        vb  = ViewBox(x=float(raw[0]), y=float(raw[1]), w=float(raw[2]), h=float(raw[3]))
        routes = [RouteRender(connectionId=cid, svg=s) for cid, s in result.get("routes", {}).items() if s]
        return RenderResult(svg=svg, viewBox=vb, units="um", layers=[], routes=routes)

    def validate_design(self, design: DesignDocument) -> ValidationResult:
        issues: list[ValidationIssue] = []
        ids = {p.id for p in design.placements}
        if not design.placements:
            issues.append(ValidationIssue(severity="warning", rule="non-empty", message="Design has no placements."))
        for c in design.connections:
            if c.from_.placementId not in ids:
                issues.append(ValidationIssue(severity="error", rule="dangling-from", message=f"Connection {c.id}: source '{c.from_.placementId}' does not exist."))
            if c.to.placementId not in ids:
                issues.append(ValidationIssue(severity="error", rule="dangling-to", message=f"Connection {c.id}: target '{c.to.placementId}' does not exist."))
            if c.from_.placementId == c.to.placementId:
                issues.append(ValidationIssue(severity="error", rule="no-self-loop", message=f"Connection {c.id} connects a component to itself."))
        return ValidationResult(valid=not any(i.severity == "error" for i in issues), issues=issues)


render_service = RenderService()
