import React, { useEffect, useRef, useState } from 'react';
import { Brush, Eraser, Hand, Lasso, Move, Pentagon, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { useOutputMask } from './useOutputMask';
import type { MaskSelectionPoint } from './useOutputMask';
import type { FrameEdit, FrameSlot, Project } from './FrameEditor';

const api = '/api/chroma';
const defaultEdit: FrameEdit = { x: 0, y: 0, zoom: 1, maskId: null };
type PreviewBackgroundMode = 'image' | 'transparent' | 'solid';
type PreviewBackgroundPreference = { mode: PreviewBackgroundMode; color: string; originalSize: boolean };
const backgroundColors = [
  { name: 'Black', value: '#000000' },
  { name: 'White', value: '#FFFFFF' },
  { name: 'Gray', value: '#808080' },
  { name: 'Green screen', value: '#00FF00' },
  { name: 'Magenta', value: '#FF00FF' },
];
function backgroundPreference(projectId: string, originalSize: boolean): PreviewBackgroundPreference {
  const fallback: PreviewBackgroundPreference = { mode: 'image', color: '#000000', originalSize };
  try {
    const saved = JSON.parse(window.localStorage.getItem(`chroma-frame-background:${projectId}`) || 'null');
    return {
      mode: saved?.mode === 'transparent' || saved?.mode === 'solid' ? saved.mode : 'image',
      color: backgroundColors.some(item => item.value === saved?.color) ? saved.color : fallback.color,
      originalSize: typeof saved?.originalSize === 'boolean' ? saved.originalSize : fallback.originalSize,
    };
  } catch { return fallback; }
}
const maskStyle = (url: string): React.CSSProperties | undefined => url ? { maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")`, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' } : undefined;
const sourceUrl = (projectId: string, frame: number) => `${api}/projects/${projectId}/frames/${frame}`;

function FrameLayer({ project, slot, edit, maskUrl, opacity = 1, onion = '' }: { project: Project; slot: FrameSlot; edit?: FrameEdit; maskUrl?: string; opacity?: number; onion?: 'previous' | 'next' | '' }) {
  if (slot.frame === null) return null;
  const values = edit || slot.edit || defaultEdit;
  const savedMask = values.maskId ? `${api}/projects/${project.id}/frame-masks/${values.maskId}` : '';
  return <div className={`chroma-single-frame-layer ${onion}`} style={{ ...maskStyle(maskUrl ?? savedMask), opacity }}>
    <img src={sourceUrl(project.id, slot.frame)} alt="" draggable={false} style={{ transform: `translate(${values.x * 100}%, ${values.y * 100}%) scale(${values.zoom})` }}/>
  </div>;
}

type Props = {
  key?: string;
  project: Project;
  index: number;
  globalMaskUrl: string;
  backgroundUrl: string;
  backgroundOriginalSize: boolean;
  onSave: (index: number, edit: FrameEdit | undefined) => Promise<void>;
  onClose: () => void;
  onNavigate: (index: number) => void;
};

export default function SingleFrameEditor({ project, index, globalMaskUrl, backgroundUrl, backgroundOriginalSize, onSave, onClose, onNavigate }: Props) {
  const slot = project.slots[index];
  const [draft, setDraft] = useState<FrameEdit>({ ...defaultEdit, ...slot.edit });
  const draftRef = useRef(draft);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'position' | 'mask' | 'selection'>('position');
  const [selectionTool, setSelectionTool] = useState<'lasso' | 'polygon'>('lasso');
  const [selection, setSelection] = useState<MaskSelectionPoint[] | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<MaskSelectionPoint[]>([]);
  const [selectionHover, setSelectionHover] = useState<MaskSelectionPoint | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [showPrevious, setShowPrevious] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [onionOpacity, setOnionOpacity] = useState(28);
  const [previewBackground, setPreviewBackground] = useState(() => backgroundPreference(project.id, backgroundOriginalSize));
  const [actualSize, setActualSize] = useState(false);
  const [viewZoom, setViewZoom] = useState(1);
  const [positionTool, setPositionTool] = useState<'move' | 'hand'>('hand');
  const [spacePanning, setSpacePanning] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const pendingMask = useRef<Promise<void>>(Promise.resolve());
  const maskDirty = useRef(false);
  const maskDraftUrl = useRef('');
  const drag = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number; width: number; height: number } | null>(null);
  const pan = useRef<{ pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const selectionPointer = useRef<{ pointerId: number; points: MaskSelectionPoint[] } | null>(null);
  const spacePressed = useRef(false);
  const maskActionRef = useRef<(action: 'erase' | 'restore') => void>(() => {});
  const modeRef = useRef(mode);
  const resizeBrushRef = useRef<(delta: number) => void>(() => {});
  const undoMaskRef = useRef<() => void>(() => {});
  const closePolygonRef = useRef<() => boolean>(() => false);
  const cancelSelectionRef = useRef<() => void>(() => {});
  modeRef.current = mode;

  useEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const measure = () => {
      const bounds = canvas.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      setCanvasSize({ width: Math.round(bounds.width), height: Math.round(bounds.height) });
      setViewportSize({ width: Math.round(viewportBounds.width), height: Math.round(viewportBounds.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !event.isComposing && event.code === 'KeyZ' && (modeRef.current === 'mask' || modeRef.current === 'selection')) {
        if (target?.isContentEditable || target?.closest('input:not([type="range"]), select, textarea')) return;
        event.preventDefault();
        undoMaskRef.current();
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && event.code === 'KeyD') {
        cancelSelectionRef.current();
        event.preventDefault();
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (target?.isContentEditable || target?.closest('input:not([type="range"]), select, textarea')) return;
      if (event.code === 'Space') {
        spacePressed.current = true;
        setSpacePanning(true);
        event.preventDefault();
      } else if (event.code === 'KeyV') {
        setMode('position');
        setPositionTool('move');
        event.preventDefault();
      } else if (event.code === 'KeyH') {
        setMode('position');
        setPositionTool('hand');
        event.preventDefault();
      } else if (event.code === 'KeyE') {
        maskActionRef.current('erase');
        setMode('mask');
        event.preventDefault();
      } else if (event.code === 'KeyR') {
        maskActionRef.current('restore');
        setMode('mask');
        event.preventDefault();
      } else if (event.code === 'KeyL') {
        setSelectionDraft([]);
        setSelectionHover(null);
        setSelectionTool('lasso');
        setMode('selection');
        event.preventDefault();
      } else if (event.code === 'KeyP') {
        setSelectionDraft([]);
        setSelectionHover(null);
        setSelectionTool('polygon');
        setMode('selection');
        event.preventDefault();
      } else if (!event.shiftKey && modeRef.current === 'mask' && (event.code === 'BracketLeft' || event.key === '[')) {
        resizeBrushRef.current(-4);
        event.preventDefault();
      } else if (!event.shiftKey && modeRef.current === 'mask' && (event.code === 'BracketRight' || event.key === ']')) {
        resizeBrushRef.current(4);
        event.preventDefault();
      } else if (modeRef.current === 'selection' && event.code === 'Enter' && !target?.closest('button')) {
        if (closePolygonRef.current()) event.preventDefault();
      } else if (event.code === 'Escape') {
        cancelSelectionRef.current();
        event.preventDefault();
      }
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') { spacePressed.current = false; setSpacePanning(false); } };
    const blur = () => { spacePressed.current = false; setSpacePanning(false); };
    const suppressContextMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('contextmenu', suppressContextMenu, true);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); window.removeEventListener('contextmenu', suppressContextMenu, true); };
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(`chroma-frame-background:${project.id}`, JSON.stringify(previewBackground)); }
    catch { /* The preview still works when browser storage is unavailable. */ }
  }, [project.id, previewBackground]);
  useEffect(() => {
    if (mode === 'selection') return;
    selectionPointer.current = null;
    setSelectionDraft(current => current.length ? [] : current);
    setSelectionHover(null);
  }, [mode]);

  function updateDraft(change: Partial<FrameEdit>) {
    const next = { ...draftRef.current, ...change };
    draftRef.current = next;
    setDraft(next);
    setDirty(true);
  }
  const mask = useOutputMask(project.id, project.width, project.height, index + 1, pending => { pendingMask.current = pending; }, {
    loadUrl: slot.edit?.maskId ? `${api}/projects/${project.id}/frame-masks/${slot.edit.maskId}` : null,
    save: async url => {
      maskDirty.current = true;
      maskDraftUrl.current = url;
      setDirty(true);
    },
  });
  maskActionRef.current = mask.setAction;
  resizeBrushRef.current = delta => mask.setBrushSize(value => Math.max(4, Math.min(mask.maxBrushSize, value + delta)));
  undoMaskRef.current = () => { if (mask.canUndo && mask.ready) void mask.undo(); };

  function clearSelection() {
    selectionPointer.current = null;
    setSelection(null);
    setSelectionDraft([]);
    setSelectionHover(null);
    mask.setSelection(null);
  }
  function finishSelection(points: MaskSelectionPoint[]) {
    setSelectionDraft([]);
    setSelectionHover(null);
    if (!mask.setSelection(points)) return;
    setSelection(points);
  }
  function closePolygon() {
    if (mode !== 'selection' || selectionTool !== 'polygon' || selectionDraft.length < 3) return false;
    finishSelection(selectionDraft);
    return true;
  }
  closePolygonRef.current = closePolygon;
  cancelSelectionRef.current = clearSelection;
  function selectionPoint(event: React.PointerEvent<HTMLDivElement>): MaskSelectionPoint {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(project.width, (event.clientX - rect.left) / rect.width * project.width)),
      y: Math.max(0, Math.min(project.height, (event.clientY - rect.top) / rect.height * project.height)),
    };
  }
  function onSelectionDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button === 1 || spacePressed.current) { startPan(event); return; }
    if (event.button !== 0) return;
    const point = selectionPoint(event);
    event.preventDefault();
    event.currentTarget.focus();
    if (selectionTool === 'lasso') {
      setSelection(null);
      mask.setSelection(null);
      selectionPointer.current = { pointerId: event.pointerId, points: [point] };
      setSelectionDraft([point]);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const first = selectionDraft[0];
    const closeRadius = 12 * project.width / event.currentTarget.getBoundingClientRect().width;
    if (selectionDraft.length >= 3 && first && Math.hypot(point.x - first.x, point.y - first.y) <= closeRadius) {
      finishSelection(selectionDraft);
      return;
    }
    if (event.detail >= 2 && selectionDraft.length >= 3) {
      finishSelection(selectionDraft);
      return;
    }
    if (!selectionDraft.length) { setSelection(null); mask.setSelection(null); }
    setSelectionDraft(current => [...current, point]);
  }
  function onSelectionMove(event: React.PointerEvent<HTMLDivElement>) {
    if (movePan(event)) return;
    const point = selectionPoint(event);
    const drawing = selectionPointer.current;
    if (drawing?.pointerId === event.pointerId) {
      const last = drawing.points[drawing.points.length - 1];
      const spacing = 2 * project.width / event.currentTarget.getBoundingClientRect().width;
      if (Math.hypot(point.x - last.x, point.y - last.y) >= spacing) {
        drawing.points.push(point);
        setSelectionDraft([...drawing.points]);
      }
    } else if (selectionTool === 'polygon' && selectionDraft.length) setSelectionHover(point);
  }
  function onSelectionEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (endPan(event)) return;
    const drawing = selectionPointer.current;
    if (!drawing || drawing.pointerId !== event.pointerId) return;
    selectionPointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    finishSelection(drawing.points);
  }
  function onSelectionCancel(event: React.PointerEvent<HTMLDivElement>) {
    if (endPan(event)) return;
    if (selectionPointer.current?.pointerId !== event.pointerId) return;
    selectionPointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setSelectionDraft([]);
  }

  async function save(nextIndex?: number) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await pendingMask.current;
      const value = { ...draftRef.current };
      if (maskDirty.current) {
        if (maskDraftUrl.current) {
          const response = await fetch(`${api}/projects/${project.id}/frame-masks`, { method: 'POST', headers: { 'X-Chroma-Save': '1' }, body: await (await fetch(maskDraftUrl.current)).blob() });
          if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `Mask save failed (HTTP ${response.status}).`); }
          value.maskId = (await response.json()).maskId;
        } else value.maskId = null;
      }
      const edit = value.x === 0 && value.y === 0 && value.zoom === 1 && !value.maskId ? undefined : value;
      const original = { ...defaultEdit, ...slot.edit };
      const changed = edit ? edit.x !== original.x || edit.y !== original.y || edit.zoom !== original.zoom || edit.maskId !== original.maskId : Boolean(slot.edit);
      if (changed) await onSave(index, edit);
      if (nextIndex === undefined) onClose();
      else onNavigate(nextIndex);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  }
  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    event.preventDefault();
    pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function movePan(event: React.PointerEvent<HTMLDivElement>) {
    const current = pan.current;
    const viewport = viewportRef.current;
    if (!current || !viewport || current.pointerId !== event.pointerId) return false;
    viewport.scrollLeft = current.scrollLeft - (event.clientX - current.x);
    viewport.scrollTop = current.scrollTop - (event.clientY - current.y);
    return true;
  }
  function endPan(event: React.PointerEvent<HTMLDivElement>) {
    if (pan.current?.pointerId !== event.pointerId) return false;
    pan.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    return true;
  }
  function onPositionDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    if (positionTool === 'hand' || event.button === 1 || spacePressed.current) { startPan(event); return; }
    if (!slot.frame) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: draftRef.current.x, originY: draftRef.current.y, width: bounds.width, height: bounds.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onPositionMove(event: React.PointerEvent<HTMLDivElement>) {
    if (movePan(event)) return;
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    updateDraft({ x: Math.max(-1, Math.min(1, current.originX + (event.clientX - current.x) / current.width)), y: Math.max(-1, Math.min(1, current.originY + (event.clientY - current.y) / current.height)) });
  }
  function onPositionEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (endPan(event)) return;
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const previous = project.slots[index - 1];
  const next = project.slots[index + 1];
  const currentMask = maskDirty.current ? mask.previewUrl : mask.previewUrl || (draft.maskId ? `${api}/projects/${project.id}/frame-masks/${draft.maskId}` : '');
  const showMaskGuide = showOverlay && Boolean(mask.overlayUrl);
  const previewScale = canvasSize.width && project.width ? Math.round(canvasSize.width / project.width * 100) : null;
  const canvasWidth = viewportSize.width ? Math.round((actualSize ? project.width : viewportSize.width) * viewZoom) : undefined;
  const canvasRatio = project.width / project.height;
  function zoomView(direction: -1 | 1) { setViewZoom(value => Math.max(.5, Math.min(4, Math.round((value + direction * .25) * 100) / 100))); }

  return <div className="chroma-single-frame-backdrop">
    <section className="chroma-single-frame-dialog" role="dialog" aria-modal="true" aria-label={`Edit frame ${index + 1}`}>
      <header><div><strong>Edit frame {index + 1} / {project.slots.length}</strong><span>Source {slot.frame === null ? 'Empty' : `#${slot.frame}`} · Changes affect this Edited timeline slot only</span></div><div><button type="button" disabled={index === 0 || saving} onClick={() => void save(index - 1)}>Previous</button><button type="button" disabled={index === project.slots.length - 1 || saving} onClick={() => void save(index + 1)}>Next</button><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={saving || !mask.ready} onClick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</button></div></header>
      <div className="chroma-single-frame-body">
        <div className="chroma-single-frame-tool-rail" role="toolbar" aria-label="Frame editing tools">
          <button type="button" className={mode === 'position' && positionTool === 'move' ? 'active' : ''} aria-label="Move image (V)" aria-pressed={mode === 'position' && positionTool === 'move'} title="Move image (V)" onClick={() => { setMode('position'); setPositionTool('move'); }}><Move size={17}/></button>
          <button type="button" className={mode === 'position' && positionTool === 'hand' ? 'active' : ''} aria-label="Hand: pan canvas (H)" aria-pressed={mode === 'position' && positionTool === 'hand'} title="Hand: pan canvas (H)" onClick={() => { setMode('position'); setPositionTool('hand'); }}><Hand size={17}/></button>
          <span className="chroma-single-frame-tool-divider" aria-hidden="true"/>
          <button type="button" className={mode === 'mask' && mask.action === 'erase' ? 'active' : ''} aria-label="Erase frame mask (E)" aria-pressed={mode === 'mask' && mask.action === 'erase'} title="Erase frame mask (E)" onClick={() => { mask.setAction('erase'); setMode('mask'); }}><Eraser size={17}/></button>
          <button type="button" className={mode === 'mask' && mask.action === 'restore' ? 'active' : ''} aria-label="Restore frame mask (R)" aria-pressed={mode === 'mask' && mask.action === 'restore'} title="Restore frame mask (R)" onClick={() => { mask.setAction('restore'); setMode('mask'); }}><Brush size={17}/></button>
          <span className="chroma-single-frame-tool-divider" aria-hidden="true"/>
          <button type="button" className={mode === 'selection' && selectionTool === 'lasso' ? 'active' : ''} aria-label="Freehand lasso selection (L)" aria-pressed={mode === 'selection' && selectionTool === 'lasso'} title="Freehand lasso selection (L)" onClick={() => { setSelectionDraft([]); setSelectionHover(null); setSelectionTool('lasso'); setMode('selection'); }}><Lasso size={17}/></button>
          <button type="button" className={mode === 'selection' && selectionTool === 'polygon' ? 'active' : ''} aria-label="Polygon selection (P)" aria-pressed={mode === 'selection' && selectionTool === 'polygon'} title="Polygon selection (P)" onClick={() => { setSelectionDraft([]); setSelectionHover(null); setSelectionTool('polygon'); setMode('selection'); }}><Pentagon size={17}/></button>
        </div>
        <div className="chroma-single-frame-workspace">
          <div className="chroma-single-frame-preview-heading"><span>Preview window <b>{viewportSize.width} × {viewportSize.height}</b> CSS px</span>{previewScale !== null && <span>Shown at <b>{previewScale}%</b></span>}<div className="chroma-single-frame-view-tools"><button type="button" aria-label="Zoom out canvas" title="Zoom out canvas" disabled={viewZoom <= .5} onClick={() => zoomView(-1)}><ZoomOut size={14}/></button><span>View {Math.round(viewZoom * 100)}%</span><button type="button" aria-label="Zoom in canvas" title="Zoom in canvas" disabled={viewZoom >= 4} onClick={() => zoomView(1)}><ZoomIn size={14}/></button></div><button type="button" aria-pressed={actualSize && viewZoom === 1} onClick={() => { setActualSize(true); setViewZoom(1); }}>Show at 100%</button><button type="button" onClick={() => { setActualSize(false); setViewZoom(1); }}>Fit window</button><label className="chroma-single-frame-mask-toggle" title="Show erased mask areas in red; turn off to inspect transparency"><input type="checkbox" checked={showOverlay} onChange={event => setShowOverlay(event.target.checked)}/> Show mask</label></div>
          <div ref={viewportRef} className="chroma-single-frame-canvas-viewport" style={{ aspectRatio: `${project.width} / ${project.height}`, '--frame-viewport-width': `${68 * canvasRatio}vh`, '--frame-mobile-viewport-width': `${55 * canvasRatio}vh` } as React.CSSProperties}>
          <div ref={canvasRef} className="chroma-single-frame-canvas checker" style={{ aspectRatio: `${project.width} / ${project.height}`, width: canvasWidth }}>
            {previewBackground.mode === 'image' && backgroundUrl && <img className={`chroma-single-frame-background ${previewBackground.originalSize ? 'original-size' : ''}`} src={backgroundUrl} alt="Preview background"/>}
            {previewBackground.mode === 'solid' && <div className="chroma-single-frame-solid-background" style={{ backgroundColor: previewBackground.color }} aria-hidden="true"/>}
            <div className="chroma-single-frame-global-mask" style={maskStyle(globalMaskUrl)}>
              <FrameLayer project={project} slot={slot} edit={draft} maskUrl={showMaskGuide ? '' : currentMask}/>
              {showPrevious && previous && <FrameLayer project={project} slot={previous} onion="previous" opacity={onionOpacity / 100}/>}
              {showNext && next && <FrameLayer project={project} slot={next} onion="next" opacity={onionOpacity / 100}/>}
            </div>
            {showMaskGuide && <img className="chroma-single-frame-mask-overlay" src={mask.overlayUrl} alt="" aria-hidden="true"/>}
            {mode === 'position' ? <div className={`chroma-single-frame-interaction position ${positionTool === 'move' ? 'move-image' : ''} ${spacePanning ? 'space-pan' : ''}`} role="button" tabIndex={0} aria-label={positionTool === 'move' && !spacePanning ? 'Drag to move this frame image' : 'Drag to pan canvas'} onPointerDown={onPositionDown} onPointerMove={onPositionMove} onPointerUp={onPositionEnd} onPointerCancel={onPositionEnd} onKeyDown={event => { if (positionTool !== 'move' || spacePanning) return; const step = event.shiftKey ? .05 : .01; if (event.key === 'ArrowLeft') updateDraft({ x: Math.max(-1, draft.x - step) }); else if (event.key === 'ArrowRight') updateDraft({ x: Math.min(1, draft.x + step) }); else if (event.key === 'ArrowUp') updateDraft({ y: Math.max(-1, draft.y - step) }); else if (event.key === 'ArrowDown') updateDraft({ y: Math.min(1, draft.y + step) }); else return; event.preventDefault(); }}/>
              : mode === 'mask' ? <div className={`chroma-single-frame-interaction mask ${spacePanning ? 'space-pan' : ''}`} aria-label="Paint this frame mask; hold Space or use middle mouse to pan" onPointerDown={event => { if (event.button === 1 || spacePressed.current) startPan(event); else mask.onPointerDown(event); }} onPointerMove={event => { if (!movePan(event)) mask.onPointerMove(event); }} onPointerUp={event => { if (!endPan(event)) mask.onPointerEnd(event); }} onPointerCancel={event => { if (!endPan(event)) mask.onPointerEnd(event); }} onPointerLeave={() => mask.setCursor(null)}>{mask.cursor && <span className="chroma-single-frame-brush-cursor" style={{ left: `${mask.cursor.x / project.width * 100}%`, top: `${mask.cursor.y / project.height * 100}%`, width: `${mask.brushSize / project.width * 100}%`, height: `${mask.brushSize / project.height * 100}%`, backgroundImage: `url("${mask.brushStamps.cursor}")` }}/>}</div>
              : <div className={`chroma-single-frame-interaction selection ${spacePanning ? 'space-pan' : ''}`} tabIndex={0} aria-label={selectionTool === 'lasso' ? 'Drag to draw a freehand mask selection' : 'Click polygon corners; right-click to undo the last corner; press Enter to close'} onPointerDown={onSelectionDown} onPointerMove={onSelectionMove} onPointerUp={onSelectionEnd} onPointerCancel={onSelectionCancel} onPointerLeave={() => setSelectionHover(null)} onContextMenu={event => { if (selectionTool !== 'polygon') return; event.preventDefault(); if (selectionDraft.length === 1) setSelectionHover(null); setSelectionDraft(current => current.slice(0, -1)); }} onDoubleClick={event => { if (selectionTool === 'polygon' && selectionDraft.length >= 3) { event.preventDefault(); finishSelection(selectionDraft); } }}/>}
            {(selection || selectionDraft.length > 0) && <svg className="chroma-single-frame-selection-outline" viewBox={`0 0 ${project.width} ${project.height}`} preserveAspectRatio="none" aria-hidden="true">
              {selection && <><polygon points={selection.map(point => `${point.x},${point.y}`).join(' ')} className="selection-shadow"/><polygon points={selection.map(point => `${point.x},${point.y}`).join(' ')} className="selection-dashes"/></>}
              {selectionDraft.length > 0 && <polyline points={[...selectionDraft, ...(selectionHover && selectionTool === 'polygon' ? [selectionHover] : [])].map(point => `${point.x},${point.y}`).join(' ')} className="selection-draft"/>}
            </svg>}
          </div>
          </div>
          <p>View zoom and canvas panning do not change the frame. Mask strokes stay fixed on the output canvas.</p>
        </div>
        <aside className="chroma-single-frame-controls">
          {mode === 'position' ? <section><h3>Position</h3><p>{positionTool === 'move' ? 'Drag to move this frame image; arrow keys make precise adjustments.' : 'Drag the canvas to pan the view.'} Hold Space for a temporary hand tool.</p><label>Image zoom <b>{draft.zoom.toFixed(2)}×</b><input type="range" min="0.5" max="2" step="0.01" value={draft.zoom} onChange={event => updateDraft({ zoom: Number(event.target.value) })}/></label><div className="chroma-single-frame-actions"><button type="button" onClick={() => updateDraft({ x: 0, y: 0 })}><RotateCcw size={13}/> Reset position</button><button type="button" onClick={() => updateDraft({ zoom: 1 })}><RotateCcw size={13}/> Reset zoom</button></div></section>
            : mode === 'selection' ? <section><h3>Mask selection</h3><p>{selectionTool === 'lasso' ? 'Drag around an area to draw a freehand selection.' : 'Click corners to draw a polygon. Right-click removes the last corner; click near the first corner or press Enter to close.'}</p><p>Press L for lasso, P for polygon, or Ctrl+D to deselect. Apply Erase or Restore below, or switch to a brush to paint only inside the selection.</p>{selectionDraft.length > 0 && <div className="chroma-single-frame-actions"><button type="button" onClick={closePolygon} disabled={selectionTool !== 'polygon' || selectionDraft.length < 3}>Close polygon</button><button type="button" onClick={clearSelection}>Cancel outline</button></div>}</section>
            : <section><h3>Frame mask</h3><p>This mask affects only this timeline slot. It stays fixed on the output canvas.</p><div className="chroma-single-frame-actions"><button type="button" className={mask.edge === 'hard' ? 'active' : ''} onClick={() => mask.setEdge('hard')}>Hard edge</button><button type="button" className={mask.edge === 'soft' ? 'active' : ''} onClick={() => mask.setEdge('soft')}>Soft edge</button></div>{mask.edge === 'soft' && <label>Softness <b>{mask.softness}%</b><input type="range" min="0" max="100" value={mask.softness} onChange={event => mask.setSoftness(Number(event.target.value))}/></label>}<label>Brush size <b>{mask.brushSize} px</b><input type="range" min="4" max={mask.maxBrushSize} value={mask.brushSize} onChange={event => mask.setBrushSize(Number(event.target.value))}/></label><div className="chroma-mask-brush-preview"><div className="chroma-brush-preview-checker" role="img" aria-label={`${mask.edge === 'soft' ? `${mask.softness}% soft` : 'Hard edge'} ${mask.action} brush preview`}><img src={mask.brushStamps.preview} alt=""/></div><span>Brush preview<small>{mask.edge === 'soft' ? `Soft edge · ${mask.softness}%` : 'Hard edge'} · {mask.brushSize} px</small></span></div><div className="chroma-single-frame-actions"><button type="button" disabled={!mask.canUndo} onClick={() => void mask.undo()}>Undo stroke</button><button type="button" disabled={!currentMask} onClick={mask.reset}>Reset mask</button></div><small role="status">{mask.status}</small></section>}
          {mode === 'mask' && <p>[ / ] resize brush · Ctrl+Z undo stroke</p>}
          {selection && <section><h3>Selected area</h3><p>The selection stays on this canvas while you switch tools. Only applied mask changes are saved.</p><div className="chroma-single-frame-actions"><button type="button" disabled={!mask.ready} onClick={() => mask.applySelection('erase')}>Erase selected</button><button type="button" disabled={!mask.ready} onClick={() => mask.applySelection('restore')}>Restore selected</button><button type="button" onClick={clearSelection}>Deselect</button></div><div className="chroma-single-frame-actions"><button type="button" disabled={!mask.canUndo} onClick={() => void mask.undo()}>Undo mask change</button></div></section>}
          {mode === 'selection' && <p>Ctrl+Z undo mask change</p>}
          <section><h3>Onion skin</h3><label className="chroma-single-frame-check"><input type="checkbox" checked={showPrevious} disabled={!previous} onChange={event => setShowPrevious(event.target.checked)}/> Previous slot {previous ? `#${index}` : ''}</label><label className="chroma-single-frame-check"><input type="checkbox" checked={showNext} disabled={!next} onChange={event => setShowNext(event.target.checked)}/> Next slot {next ? `#${index + 2}` : ''}</label><label>Opacity <b>{onionOpacity}%</b><input type="range" min="5" max="60" value={onionOpacity} onChange={event => setOnionOpacity(Number(event.target.value))}/></label></section>
          <section><h3>Preview background</h3><div className="chroma-single-frame-background-options" role="radiogroup" aria-label="Preview background mode">
            <label className="chroma-single-frame-check"><input type="radio" name="frame-preview-background" checked={previewBackground.mode === 'image'} onChange={() => setPreviewBackground(current => ({ ...current, mode: 'image' }))}/> Background image</label>
            <label className="chroma-single-frame-check"><input type="radio" name="frame-preview-background" checked={previewBackground.mode === 'transparent'} onChange={() => setPreviewBackground(current => ({ ...current, mode: 'transparent' }))}/> Transparent pixels</label>
            <label className="chroma-single-frame-check"><input type="radio" name="frame-preview-background" checked={previewBackground.mode === 'solid'} onChange={() => setPreviewBackground(current => ({ ...current, mode: 'solid' }))}/> Solid color</label>
          </div>
          {previewBackground.mode === 'image' && (backgroundUrl ? <div className="chroma-single-frame-actions"><button type="button" className={previewBackground.originalSize ? 'active' : ''} aria-pressed={previewBackground.originalSize} onClick={() => setPreviewBackground(current => ({ ...current, originalSize: true }))}>Original size</button><button type="button" className={!previewBackground.originalSize ? 'active' : ''} aria-pressed={!previewBackground.originalSize} onClick={() => setPreviewBackground(current => ({ ...current, originalSize: false }))}>Fit window</button></div> : <p>No background image is set. Add one in Output Edit.</p>)}
          {previewBackground.mode === 'solid' && <div className="chroma-single-frame-color-options" aria-label="Solid background color">{backgroundColors.map(option => <button key={option.value} type="button" className={previewBackground.color === option.value ? 'active' : ''} aria-pressed={previewBackground.color === option.value} aria-label={option.name} title={option.name} onClick={() => setPreviewBackground(current => ({ ...current, color: option.value }))}><span className="chroma-single-frame-color-swatch" style={{ backgroundColor: option.value }}/><span>{option.name}</span></button>)}</div>}
          </section>
          {error && <p className="chroma-single-frame-error" role="alert">{error}</p>}
          {dirty && <small>Unsaved changes in this frame</small>}
        </aside>
      </div>
    </section>
  </div>;
}
