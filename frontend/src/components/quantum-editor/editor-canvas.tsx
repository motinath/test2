import {
  useRef, useState, useEffect, useCallback, useMemo,
  forwardRef, useImperativeHandle,
} from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { prefixForCategory, type EditorState } from "@/lib/editor/design-store";
import { useWorkspace } from "@/lib/editor/workspace-store";
import {
  componentPinsQueryOptions,
  componentPreviewQueryOptions,
  componentsQueryOptions,
  componentMetadataQueryOptions,
} from "@/lib/bridge/queries";
import { defaultParamsFromMetadata } from "@/lib/bridge/adapters";
import { bridgeClient } from "@/lib/bridge/client";
import type { ComponentSummary, PinSpec, Placement, RenderResult, ComponentMetadata } from "@/lib/bridge/types";
import { cn } from "@/lib/utils";
import { QISKIT_CATALOG } from "./qiskit-metal-catalog";

const MM_TO_PX  = 80;
const UM_TO_MM  = 0.001;
const RULER_L   = 28;
const RULER_B   = 28;
const SCROLL_SZ = 10;
const WORLD_H   = 20;
const UI_SCALE_KEY = "_uiScale";
const SCALE_MIN = 0.25;
const SCALE_MAX = 5.0;
const SCALE_STEP = 0.1;
const LIB_DRAG_START = "silicofeller:component-drag-start";
const LIB_DRAG_END   = "silicofeller:component-drag-end";

export interface EditorCanvasHandle {
  fitToContent: () => void;
  getSvgElement: () => SVGSVGElement | null;
}

type DragState =
  | { mode: "pan"; startX: number; startY: number; panX: number; panY: number }
  | { mode: "move"; id: string; offsetX: number; offsetY: number }
  | null;

function getUiScale(p: Placement): number {
  const v = p.params[UI_SCALE_KEY];
  return typeof v === "number" && v > 0 ? v : 1;
}

function rulerTicks(worldStart: number, worldEnd: number, pixLen: number) {
  const span = worldEnd - worldStart;
  if (span <= 0 || pixLen <= 0) return [];
  const raw  = span / (pixLen / 80);
  const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
  let step   = mag;
  if (raw / mag > 5) step = mag * 5; else if (raw / mag > 2) step = mag * 2;
  const first = Math.ceil(worldStart / step) * step;
  const ticks: { value: number; px: number; major: boolean }[] = [];
  for (let v = first; v <= worldEnd + step * 0.01; v += step) {
    const px = ((v - worldStart) / span) * pixLen;
    if (px < 0 || px > pixLen) continue;
    ticks.push({ value: parseFloat(v.toFixed(8)), px, major: Math.abs(Math.round(v / step) % 5) === 0 });
  }
  return ticks;
}

function fmtTick(v: number, step: number): string {
  if (Math.abs(v) < 1e-9) return "0";
  if (step < 0.01) return `${(v * 1000).toFixed(0)}µ`;
  return `${v.toFixed(step < 0.5 ? 1 : 0)}`;
}

export const EditorCanvas = forwardRef<EditorCanvasHandle, object>(function EditorCanvas(_p, ref) {
  const { activeTab, dispatchActive } = useWorkspace();
  const state    = activeTab.state;
  const dispatch = dispatchActive;
  const doc      = { placements: state.placements, connections: state.connections };
  const qc       = useQueryClient();
  const uniqueName = useCallback((prefix: string) => {
    let n = 0;
    const taken = new Set(state.placements.map((p) => p.name));
    while (taken.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }, [state.placements]);

  const svgRef       = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size,      setSize]      = useState({ w: 800, h: 600 });
  const [drag,      setDrag]      = useState<DragState>(null);
  const [libDragId, setLibDragId] = useState<string | null>(null);
  const [dropPrev,  setDropPrev]  = useState<{ componentId: string; x: number; y: number } | null>(null);
  const [dragOver,  setDragOver]  = useState(false);

  const canvasW = size.w - RULER_L;
  const canvasH = size.h - RULER_B;

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const compsQ = useQuery(componentsQueryOptions());
  const compsById = useMemo(() => {
    const m = new Map<string, ComponentSummary>();
    // Seed from static catalog first as fallback
    QISKIT_CATALOG.forEach((c) => m.set(c.className, {
      id: c.className,
      name: c.label,
      module: c.modulePath,
      category: (c.category === "tlines" ? "routes" :
                  c.category === "lumped" ? "other" :
                  c.category === "sample shapes" ? "other" : c.category) as any,
      description: c.description,
    }));
    // Override with live bridge data if available
    (compsQ.data ?? []).forEach((c) => m.set(c.id, c));
    return m;
  }, [compsQ.data]);

  const renderQ = useQuery({
    queryKey: ["bridge", "render", doc],
    queryFn: ({ signal }) => bridgeClient.renderDesign(doc, signal).then((r) => { if (r.error) throw new Error(r.error); return r.data!; }),
    enabled: doc.placements.length > 0, staleTime: 0,
    placeholderData: (prev) => prev,
  });
  const routeSvg = useMemo(() => { const m = new Map<string, string>(); (renderQ.data?.routes ?? []).forEach((r) => m.set(r.connectionId, r.svg)); return m; }, [renderQ.data?.routes]);
  const pinQueries = useQueries({ queries: state.placements.map((p) => componentPinsQueryOptions(p.componentId)) });

  useEffect(() => {
    const onS = (e: Event) => { const id = (e as CustomEvent<{ componentId?: string }>).detail?.componentId; if (id) setLibDragId(id); };
    const onE = () => { setLibDragId(null); setDropPrev(null); };
    window.addEventListener(LIB_DRAG_START, onS); window.addEventListener(LIB_DRAG_END, onE);
    return () => { window.removeEventListener(LIB_DRAG_START, onS); window.removeEventListener(LIB_DRAG_END, onE); };
  }, []);

  const w2s = useCallback((x: number, y: number) => ({
    px: RULER_L + canvasW / 2 + (x * MM_TO_PX + state.pan.x) * state.zoom,
    py:          canvasH / 2 - (y * MM_TO_PX - state.pan.y) * state.zoom,
  }), [canvasW, canvasH, state.pan, state.zoom]);

  const s2w = useCallback((px: number, py: number) => ({
    x:  (px - RULER_L - canvasW / 2) / state.zoom / MM_TO_PX - state.pan.x / MM_TO_PX,
    y: -(py -           canvasH / 2) / state.zoom / MM_TO_PX + state.pan.y / MM_TO_PX,
  }), [canvasW, canvasH, state.pan, state.zoom]);

  const zoomRef = useRef(state.zoom);
  useEffect(() => {
    zoomRef.current = state.zoom;
  }, [state.zoom]);

  useEffect(() => {
    const svg = svgRef.current; if (!svg) return;
    const onW = (e: WheelEvent) => { e.preventDefault(); dispatch({ type: "ZOOM", zoom: zoomRef.current * (e.deltaY < 0 ? 1.1 : 1/1.1) }); };
    svg.addEventListener("wheel", onW, { passive: false }); return () => svg.removeEventListener("wheel", onW);
  }, [dispatch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch({ type: "CANCEL_PIN" });
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); dispatch({ type: "UNDO" }); }
      if ((e.metaKey || e.ctrlKey) && (e.key === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); dispatch({ type: "REDO" }); }
      if ((e.key === "Delete" || e.key === "Backspace") && state.selection && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        if (state.selection.kind === "placement") dispatch({ type: "DELETE_PLACEMENT", id: state.selection.id });
        else dispatch({ type: "DELETE_CONNECTION", id: state.selection.id });
      }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, state.selection]);

  const onPDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const t = e.target as Element;
    if (t === e.currentTarget || t.getAttribute("data-canvas-bg") === "true" || state.tool === "pan") {
      setDrag({ mode: "pan", startX: e.clientX, startY: e.clientY, panX: state.pan.x, panY: state.pan.y });
      dispatch({ type: "SELECT", selection: null });
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    }
  };
  const onPMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const rect = svgRef.current?.getBoundingClientRect(); if (!rect) return;
    if (drag.mode === "pan") dispatch({ type: "PAN", x: drag.panX + (e.clientX - drag.startX) / state.zoom, y: drag.panY - (e.clientY - drag.startY) / state.zoom });
    else if (drag.mode === "move" && state.tool !== "pan") {
      const w = s2w(e.clientX - rect.left - drag.offsetX, e.clientY - rect.top - drag.offsetY), snap = 0.05;
      dispatch({ type: "MOVE_PLACEMENT", id: drag.id, x: Math.round(w.x / snap) * snap, y: Math.round(w.y / snap) * snap });
    }
  };
  const onPUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag && (e.currentTarget as Element).hasPointerCapture(e.pointerId)) (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    setDrag(null);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const cid = e.dataTransfer.getData("application/x-silicofeller-component"); setDropPrev(null); setLibDragId(null);
    if (!cid) return;
    const summary = compsById.get(cid);
    if (!summary) return;
    const rect = svgRef.current?.getBoundingClientRect(); if (!rect) return;
    const w = s2w(e.clientX - rect.left, e.clientY - rect.top), snap = 0.05;
    const x = Math.round(w.x / snap) * snap, y = Math.round(w.y / snap) * snap;

    // Check query cache first for instant load
    const queryKey = ["bridge", "components", cid, "metadata"] as const;
    const cachedMetadata = qc.getQueryData<ComponentMetadata>(queryKey);
    let params: Record<string, string | number> = {};

    if (cachedMetadata) {
      params = defaultParamsFromMetadata(cachedMetadata);
    } else {
      // Fall back immediately to static catalog default parameters to avoid blocking
      const catalogEntry = QISKIT_CATALOG.find((c) => c.className === cid);
      if (catalogEntry) {
        params = Object.fromEntries(
          Object.entries(catalogEntry.defaultParams).map(([k, v]) => [k, String(v)])
        );
      }
    }

    const name = uniqueName(prefixForCategory(summary.category));
    const placementId = `pl_${name}_${Date.now()}`;
    
    // Dispatch placement addition instantly
    dispatch({
      type: "ADD_PLACEMENT",
      placement: {
        id: placementId,
        componentId: cid,
        name,
        x: parseFloat(x.toFixed(3)),
        y: parseFloat(y.toFixed(3)),
        rotation: 0,
        params,
      },
    });

    // If metadata was not cached, prefetch/load it in background and merge when ready
    if (!cachedMetadata) {
      bridgeClient.getMetadata(cid).then((metaRes) => {
        if (metaRes.data) {
          const liveParams = defaultParamsFromMetadata(metaRes.data);
          dispatch({
            type: "UPDATE_PLACEMENT",
            id: placementId,
            patch: { params: liveParams },
          });
        }
      }).catch(console.error);
    }
  };
  const onDragOver = (e: React.DragEvent<SVGSVGElement>) => {
    e.preventDefault(); setDragOver(true); e.dataTransfer.dropEffect = "copy";
    const cid  = libDragId || (e.dataTransfer.types.includes("application/x-silicofeller-component") ? e.dataTransfer.getData("application/x-silicofeller-component") : "");
    const rect = svgRef.current?.getBoundingClientRect();
    if (!cid || !rect) return;
    const w = s2w(e.clientX - rect.left, e.clientY - rect.top), snap = 0.05;
    setDropPrev({ componentId: cid, x: Math.round(w.x / snap) * snap, y: Math.round(w.y / snap) * snap });
  };

  const fitToContent = useCallback(() => {
    if (!state.placements.length) { dispatch({ type: "ZOOM", zoom: 1 }); dispatch({ type: "PAN", x: 0, y: 0 }); return; }
    const xs = state.placements.map((p) => p.x), ys = state.placements.map((p) => p.y);
    const pad = 1.5, cW = Math.max(Math.max(...xs) - Math.min(...xs) + pad * 2, 2), cH = Math.max(Math.max(...ys) - Math.min(...ys) + pad * 2, 2);
    const zoom = Math.min(canvasW / (cW * MM_TO_PX), canvasH / (cH * MM_TO_PX), 4);
    dispatch({ type: "ZOOM", zoom }); dispatch({ type: "PAN", x: -((Math.min(...xs) + Math.max(...xs)) / 2) * MM_TO_PX, y: -((Math.min(...ys) + Math.max(...ys)) / 2) * MM_TO_PX });
  }, [state.placements, canvasW, canvasH, dispatch]);

  useImperativeHandle(ref, () => ({ fitToContent, getSvgElement: () => svgRef.current }), [fitToContent]);

  const hWS = s2w(RULER_L, canvasH / 2), hWE = s2w(RULER_L + canvasW, canvasH / 2);
  const vWE = s2w(RULER_L, 0), vWS = s2w(RULER_L, canvasH);
  const hTicks = useMemo(() => rulerTicks(hWS.x, hWE.x, canvasW), [hWS.x, hWE.x, canvasW]);
  const vTicks = useMemo(() => rulerTicks(vWS.y, vWE.y, canvasH), [vWS.y, vWE.y, canvasH]);
  const hStep  = hTicks.length >= 2 ? Math.abs(hTicks[1].value - hTicks[0].value) : 1;
  const vStep  = vTicks.length >= 2 ? Math.abs(vTicks[1].value - vTicks[0].value) : 1;

  const wTotal = WORLD_H * 2;
  const panXmm = -state.pan.x / MM_TO_PX, panYmm = state.pan.y / MM_TO_PX;
  const vHX = (canvasW / 2) / state.zoom / MM_TO_PX, vHY = (canvasH / 2) / state.zoom / MM_TO_PX;
  const hTS = Math.max(0, Math.min(1, (panXmm - vHX + WORLD_H) / wTotal)), hTSz = Math.min(1, (vHX * 2) / wTotal);
  const vTS = Math.max(0, Math.min(1, 1 - (panYmm + vHY + WORLD_H) / wTotal)), vTSz = Math.min(1, (vHY * 2) / wTotal);
  const trH = canvasW - SCROLL_SZ, trV = canvasH - SCROLL_SZ;



  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-background select-none">
      <svg ref={svgRef} width={size.w} height={size.h} className="block touch-none"
        style={{ cursor: state.tool === "pan" ? (drag?.mode === "pan" ? "grabbing" : "grab") : drag?.mode === "move" ? "grabbing" : "default" }}
        onPointerDown={onPDown} onPointerMove={onPMove} onPointerUp={onPUp} onPointerCancel={onPUp}
        onDragEnter={onDragOver} onDragOver={onDragOver}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDropPrev(null); setDragOver(false); } }}
        onDrop={onDrop}
      >
        <defs><clipPath id="cc"><rect x={RULER_L} y={0} width={canvasW} height={canvasH} /></clipPath></defs>

        {/* Dot-grid */}
        <rect data-canvas-bg="true" x={RULER_L} y={0} width={canvasW} height={canvasH} fill="transparent"
          style={{ backgroundImage: "radial-gradient(circle, color-mix(in oklab, var(--foreground) 15%, transparent) 1px, transparent 1px)", backgroundSize: `${24 * state.zoom}px ${24 * state.zoom}px`, backgroundPosition: `${state.pan.x * state.zoom + canvasW / 2}px ${-state.pan.y * state.zoom + canvasH / 2}px` }}
        />

        {/* Canvas content */}
        <g clipPath="url(#cc)">
          {(() => { const { px: tx, py: ty } = w2s(-4.5, 3), { px: bx, py: by } = w2s(4.5, -3); return <rect x={tx} y={ty} width={bx-tx} height={by-ty} fill={dragOver ? "color-mix(in oklab, var(--primary) 10%, transparent)" : "none"} stroke={dragOver ? "var(--primary)" : "color-mix(in oklab, var(--foreground) 20%, transparent)"} strokeWidth={dragOver ? 2 : 1.5} strokeDasharray={dragOver ? "none" : "8 5"} rx={3} />; })()}

          {state.placements.map((p) => (
            <PlacementPreview key={p.id} placement={p} w2s={w2s} zoom={state.zoom} uiScale={getUiScale(p)} />
          ))}
          {dropPrev && <DropGhost componentId={dropPrev.componentId} x={dropPrev.x} y={dropPrev.y} w2s={w2s} zoom={state.zoom} />}

          {state.placements.map((p, i) => (
            <PlacementGlyph key={p.id} placement={p} componentId={p.componentId}
              selected={state.selection?.kind === "placement" && state.selection.id === p.id}
              pendingOwner={state.pendingPin?.placementId ?? null} pendingPin={state.pendingPin?.pinName ?? null}
              pins={pinQueries[i]?.data?.pins ?? []} w2s={w2s} zoom={state.zoom} uiScale={getUiScale(p)}
              onPointerDown={(e) => {
                e.stopPropagation(); if (state.tool === "pan") return;
                dispatch({ type: "SELECT", selection: { kind: "placement", id: p.id } });
                const rect = svgRef.current?.getBoundingClientRect(); if (!rect) return;
                const sc = w2s(p.x, p.y);
                setDrag({ mode: "move", id: p.id, offsetX: e.clientX - rect.left - sc.px, offsetY: e.clientY - rect.top - sc.py });
                (e.currentTarget as Element).setPointerCapture(e.pointerId);
              }}
              onPinClick={(pin) => dispatch({ type: "PIN_CLICK", placementId: p.id, pinName: pin, defaultRouteComponentId: "RouteMeander" })}
            />
          ))}

          {state.connections.map((c) => {
            const a = state.placements.find((x) => x.id === c.from.placementId), b = state.placements.find((x) => x.id === c.to.placementId);
            if (!a || !b) return null;
            const isSel = state.selection?.kind === "connection" && state.selection.id === c.id;
            const rsvg  = routeSvg.get(c.id);
            if (rsvg && renderQ.data) {
              const sc = state.zoom * MM_TO_PX * UM_TO_MM, { px, py } = w2s(0, 0);
              return <g key={c.id} className="cursor-pointer" onClick={(e) => { e.stopPropagation(); dispatch({ type: "SELECT", selection: { kind: "connection", id: c.id } }); }}>
                {isSel && <g transform={`translate(${px} ${py}) scale(${sc} ${-sc})`} opacity={0.3} dangerouslySetInnerHTML={{ __html: rsvg }} />}
                <g transform={`translate(${px} ${py}) scale(${sc} ${-sc})`} opacity={isSel ? 1 : 0.9} dangerouslySetInnerHTML={{ __html: rsvg }} />
              </g>;
            }
            const pa = w2s(a.x, a.y), pb = w2s(b.x, b.y);
            return <g key={c.id}>
              {isSel && <path d={`M ${pa.px} ${pa.py} L ${pb.px} ${pb.py}`} stroke="var(--primary)" strokeWidth={8} strokeOpacity={0.2} fill="none" />}
              <path d={`M ${pa.px} ${pa.py} L ${pb.px} ${pb.py}`} stroke={isSel ? "var(--primary)" : "#5B9BD5"} strokeWidth={isSel ? 2.5 : 1.8} strokeDasharray={renderQ.isLoading ? "6 4" : "none"} fill="none" className="cursor-pointer" onClick={(e) => { e.stopPropagation(); dispatch({ type: "SELECT", selection: { kind: "connection", id: c.id } }); }} />
              <text x={(pa.px+pb.px)/2} y={(pa.py+pb.py)/2 - 6} textAnchor="middle" fontSize={8} fill={isSel ? "var(--primary)" : "var(--muted-foreground)"} className="pointer-events-none select-none">{renderQ.isLoading ? "rendering…" : (c.routeComponentId ?? "CPW")}</text>
            </g>;
          })}
        </g>

        {/* Left ruler */}
        <g>
          <rect x={0} y={0} width={RULER_L} height={canvasH} fill="var(--card)" />
          <line x1={RULER_L} y1={0} x2={RULER_L} y2={canvasH} stroke="var(--border)" strokeWidth={1} />
          {vTicks.map(({ value, px, major }) => { const sy = canvasH - px; return <g key={value}><line x1={major ? 10 : 18} y1={sy} x2={RULER_L} y2={sy} stroke="var(--muted-foreground)" strokeWidth={major ? 1 : 0.5} />{major && <text x={RULER_L/2} y={sy} fontSize={8} textAnchor="middle" dominantBaseline="middle" fill="var(--muted-foreground)" transform={`rotate(-90,${RULER_L/2},${sy})`} className="pointer-events-none select-none">{fmtTick(value, vStep)}</text>}</g>; })}
        </g>

        {/* Bottom ruler */}
        <g transform={`translate(0,${canvasH})`}>
          <rect x={RULER_L} y={0} width={canvasW} height={RULER_B} fill="var(--card)" />
          <line x1={RULER_L} y1={0} x2={RULER_L+canvasW} y2={0} stroke="var(--border)" strokeWidth={1} />
          {hTicks.map(({ value, px, major }) => <g key={value}><line x1={RULER_L+px} y1={0} x2={RULER_L+px} y2={major?10:6} stroke="var(--muted-foreground)" strokeWidth={major?1:0.5} />{major && <text x={RULER_L+px+2} y={RULER_B-4} fontSize={8} fill="var(--muted-foreground)" className="pointer-events-none select-none">{fmtTick(value, hStep)}</text>}</g>)}
          <rect x={0} y={0} width={RULER_L} height={RULER_B} fill="var(--muted)" />
        </g>

        {/* H scrollbar */}
        <g transform={`translate(${RULER_L},${canvasH})`}>
          <rect x={0} y={RULER_B-SCROLL_SZ} width={canvasW-SCROLL_SZ} height={SCROLL_SZ} fill="var(--muted)" />
          <rect x={2+hTS*(trH-4)} y={RULER_B-SCROLL_SZ+1} width={Math.max(20, hTSz*(trH-4))} height={SCROLL_SZ-3} fill="var(--border)" rx={3} className="cursor-pointer"
            onPointerDown={(e) => { e.stopPropagation(); const sx=e.clientX, sp=state.pan.x; const mv=(ev: PointerEvent)=>dispatch({type:"PAN",x:sp-(ev.clientX-sx)/(trH-4)*wTotal*MM_TO_PX,y:state.pan.y}); const up=()=>{window.removeEventListener("pointermove",mv);window.removeEventListener("pointerup",up);}; window.addEventListener("pointermove",mv);window.addEventListener("pointerup",up);(e.currentTarget as Element).setPointerCapture(e.pointerId); }} />
        </g>

        {/* V scrollbar */}
        <g transform={`translate(${RULER_L+canvasW-SCROLL_SZ},0)`}>
          <rect x={0} y={0} width={SCROLL_SZ} height={canvasH-SCROLL_SZ} fill="var(--muted)" />
          <rect x={1} y={2+vTS*(trV-4)} width={SCROLL_SZ-2} height={Math.max(20,vTSz*(trV-4))} fill="var(--border)" rx={3} className="cursor-pointer"
            onPointerDown={(e) => { e.stopPropagation(); const sy=e.clientY, sp=state.pan.y; const mv=(ev: PointerEvent)=>dispatch({type:"PAN",x:state.pan.x,y:sp-(ev.clientY-sy)/(trV-4)*wTotal*MM_TO_PX}); const up=()=>{window.removeEventListener("pointermove",mv);window.removeEventListener("pointerup",up);}; window.addEventListener("pointermove",mv);window.addEventListener("pointerup",up);(e.currentTarget as Element).setPointerCapture(e.pointerId); }} />
        </g>
      </svg>



      {/* Global zoom */}
      <div className="absolute bottom-3 right-4 flex items-center gap-1 rounded-full border border-border bg-card/95 px-1.5 py-1 shadow-sm backdrop-blur">
        <button type="button" onClick={() => dispatch({ type: "ZOOM", zoom: Math.max(0.25, state.zoom/1.2) })} className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"><ZoomOut className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={() => dispatch({ type: "ZOOM", zoom: 1 })} className="min-w-[44px] text-center text-[11px] font-bold text-foreground hover:text-primary" title="Reset zoom">{Math.round(state.zoom * 100)}%</button>
        <button type="button" onClick={() => dispatch({ type: "ZOOM", zoom: Math.min(8, state.zoom*1.2) })} className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"><ZoomIn className="h-3.5 w-3.5" /></button>
        <div className="mx-0.5 h-4 w-px bg-border" />
        <button type="button" onClick={fitToContent} className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" title="Fit view (F)"><Maximize2 className="h-3.5 w-3.5" /></button>
      </div>

      {state.pendingPin && <div className="absolute top-8 left-8 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-bold text-primary shadow-sm">Click another pin to connect · Esc to cancel</div>}
      {state.placements.length === 0 && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><div className="rounded-lg border border-dashed border-border bg-card/70 px-6 py-4 text-center text-xs text-muted-foreground">Drag a component from the Library to begin.</div></div>}
      {renderQ.isError && <div className="absolute bottom-12 left-8 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1 text-[10px] text-destructive">Render failed: {String(renderQ.error)}</div>}
      {renderQ.isFetching && state.connections.length > 0 && <div className="absolute bottom-12 left-8 flex items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur"><span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" /> Rendering route geometry…</div>}
    </div>
  );
});

function PlacementPreview({ placement, w2s, zoom, uiScale }: { placement: Placement; w2s: (x: number, y: number) => { px: number; py: number }; zoom: number; uiScale: number }) {
  const q = useQuery(componentPreviewQueryOptions(placement.componentId, placement.params));
  const p = q.data;
  const { px, py } = w2s(placement.x, placement.y);
  if (!p?.svg) {
    const s = Math.max(36, 0.6 * MM_TO_PX * zoom * uiScale), h = s / 2;
    return (
      <g transform={`translate(${px} ${py}) rotate(${-placement.rotation})`}>
        <rect x={-h} y={-h} width={s} height={s} rx={4} fill="color-mix(in oklab, var(--primary) 5%, transparent)" stroke="color-mix(in oklab, var(--foreground) 30%, transparent)" strokeWidth={1.5} strokeDasharray="4 3" />
      </g>
    );
  }
  const sc = zoom * MM_TO_PX * (p.units === "um" ? UM_TO_MM : 1) * uiScale;
  const vb = p.viewBox;
  return <g transform={`translate(${px} ${py}) rotate(${-placement.rotation})`}><g transform={`scale(${sc} ${-sc}) translate(${-(vb.x+vb.w/2)} ${-(vb.y+vb.h/2)})`} dangerouslySetInnerHTML={{ __html: p.svg }} style={{ transition: "transform 0.12s ease" }} /></g>;
}

function DropGhost({ componentId, x, y, w2s, zoom }: { componentId: string; x: number; y: number; w2s: (x: number, y: number) => { px: number; py: number }; zoom: number }) {
  const q = useQuery(componentPreviewQueryOptions(componentId));
  const p = q.data;
  const { px, py } = w2s(x, y);
  if (!p?.svg) { const s = Math.max(36, 0.6*MM_TO_PX*zoom), h = s/2; return <g className="pointer-events-none" transform={`translate(${px} ${py})`}><rect x={-h} y={-h} width={s} height={s} rx={4} fill="color-mix(in oklab, var(--primary) 10%, transparent)" stroke="var(--primary)" strokeDasharray="5 4" strokeOpacity={0.65} /></g>; }
  const sc = zoom * MM_TO_PX * (p.units === "um" ? UM_TO_MM : 1), vb = p.viewBox;
  return <g className="pointer-events-none" opacity={0.72}><g transform={`translate(${px} ${py})`}><g transform={`scale(${sc} ${-sc}) translate(${-(vb.x+vb.w/2)} ${-(vb.y+vb.h/2)})`} dangerouslySetInnerHTML={{ __html: p.svg }} /></g><circle cx={px} cy={py} r={4} fill="var(--primary)" stroke="var(--background)" strokeWidth={1.5} /></g>;
}

function PlacementGlyph({ placement, componentId, selected, pendingOwner, pendingPin, pins, w2s, zoom, uiScale, onPointerDown, onPinClick }: {
  placement: Placement; componentId: string; selected: boolean; pendingOwner: string | null; pendingPin: string | null;
  pins: PinSpec[]; w2s: (x: number, y: number) => { px: number; py: number }; zoom: number; uiScale: number;
  onPointerDown: (e: React.PointerEvent) => void; onPinClick: (p: string) => void;
}) {
  const q  = useQuery(componentPreviewQueryOptions(componentId, placement.params));
  const vb = q.data?.viewBox;
  const um = q.data?.units === "um" ? UM_TO_MM : 1;
  const sz = vb ? Math.max(vb.w, vb.h) * um * MM_TO_PX * zoom * uiScale : Math.max(28, 0.5*MM_TO_PX*zoom);
  const { px, py } = w2s(placement.x, placement.y), half = sz / 2;
  const isPO = pendingOwner === placement.id;
  return (
    <g transform={`translate(${px} ${py}) rotate(${-placement.rotation})`} className={cn("cursor-grab", selected && "cursor-grabbing")} onPointerDown={onPointerDown}>
      <rect x={-half} y={-half} width={sz} height={sz} fill="transparent" stroke="none" />
      {selected && <rect x={-half-6} y={-half-6} width={sz+12} height={sz+12} rx={6} fill="none" stroke="var(--primary)" strokeOpacity={0.5} strokeWidth={2} strokeDasharray="3 2" />}
      <text x={0} y={half+14} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--foreground)" className="select-none">{placement.name}</text>
      {pins.map((pin) => {
        const cx = pin.hint.x * UM_TO_MM * MM_TO_PX * zoom, cy = -pin.hint.y * UM_TO_MM * MM_TO_PX * zoom;
        const iP = isPO && pendingPin === pin.name;
        return <g key={pin.name}>
          <circle cx={cx} cy={cy} r={iP?5:3.5} fill={iP?"var(--destructive)":selected?"var(--primary)":"var(--muted-foreground)"} stroke="var(--background)" strokeWidth={1} className="cursor-crosshair" onPointerDown={(e) => { e.stopPropagation(); onPinClick(pin.name); }} />
          {selected && <text x={cx+6} y={cy+3} fontSize={8} fill="var(--foreground)" fontWeight={700} className="pointer-events-none select-none">{pin.name}</text>}
        </g>;
      })}
    </g>
  );
}
