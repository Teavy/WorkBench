import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

type BrushEdge = 'hard' | 'soft';
type BrushAction = 'erase' | 'restore';
type Cursor = { x: number; y: number };
export type MaskSelectionPoint = Cursor;
type Stroke = Cursor & {
  pointerId: number;
  changed: boolean;
  action: BrushAction;
  edge: BrushEdge;
  softness: number;
  radius: number;
  pixels: ImageData;
  originalAlpha: Uint8Array;
  coverage: Uint8Array;
};
const api = '/api/chroma';
const headers = { 'X-Chroma-Save': '1', 'Content-Type': 'image/png' };

function brushOpacity(distance: number, radius: number, edge: BrushEdge, softness: number) {
  if (distance >= radius) return 0;
  if (edge === 'hard' || softness === 0) return 1;
  const solidRadius = radius * (1 - softness / 100);
  if (distance <= solidRadius) return 1;
  const remaining = (radius - distance) / (radius - solidRadius);
  return remaining * remaining;
}

function brushStampUrl(edge: BrushEdge, softness: number, color: [number, number, number], opacity: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 80;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const pixels = context.createImageData(80, 80);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
    const index = (y * 80 + x) * 4;
    const coverage = brushOpacity(Math.hypot(x + .5 - 40, y + .5 - 40), 40, edge, softness);
    pixels.data[index] = color[0];
    pixels.data[index + 1] = color[1];
    pixels.data[index + 2] = color[2];
    pixels.data[index + 3] = Math.round(255 * coverage * opacity);
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

export function useOutputMask(projectId: string | null, width: number, height: number, revision: number, onPendingSave: (pending: Promise<void>) => void, custom?: { loadUrl: string | null; save: (url: string) => Promise<void> }) {
  const [preview, setPreview] = useState<{ key: string; url: string; overlayUrl: string }>({ key: '', url: '', overlayUrl: '' });
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('');
  const [brushSize, setBrushSize] = useState(32);
  const [edge, setEdge] = useState<BrushEdge>('soft');
  const [softness, setSoftness] = useState(45);
  const [action, setAction] = useState<BrushAction>('erase');
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keyRef = useRef('');
  const previewUrlRef = useRef('');
  const undoRef = useRef<string[]>([]);
  const strokeRef = useRef<Stroke | null>(null);
  const selectionRef = useRef<Uint8Array | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const previewRequest = useRef<number | null>(null);
  const key = projectId && width >= 16 && height >= 16 ? `${projectId}:${width}x${height}:${revision}` : '';
  const maxBrushSize = Math.min(512, Math.max(4, Math.min(width || 512, height || 512)));
  const effectiveBrushSize = Math.min(brushSize, maxBrushSize);
  const brushStamps = useMemo(() => ({
    preview: brushStampUrl(edge, softness, [255, 255, 255], 1),
    cursor: brushStampUrl(edge, softness, action === 'erase' ? [255, 96, 112] : [112, 235, 163], .38),
  }), [edge, softness, action]);

  useEffect(() => {
    let cancelled = false;
    keyRef.current = key;
    previewUrlRef.current = '';
    undoRef.current = [];
    strokeRef.current = null;
    selectionRef.current = null;
    setPreview({ key, url: '', overlayUrl: '' });
    setReady(false);
    setStatus('');
    if (!projectId || !key) return;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) { setStatus('Canvas is unavailable.'); return; }
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    canvasRef.current = canvas;
    void (async () => {
      try {
        await saveQueue.current;
        if (custom && !custom.loadUrl) { if (!cancelled) setReady(true); return; }
        const response = await fetch(custom ? custom.loadUrl! : `${api}/projects/${projectId}/mask`, { cache: 'no-store' });
        if (response.status === 404) { if (!cancelled) setReady(true); return; }
        if (!response.ok) throw new Error(`Could not load output mask (HTTP ${response.status}).`);
        const bitmap = await createImageBitmap(await response.blob());
        if (!cancelled) {
          context.clearRect(0, 0, width, height);
          context.drawImage(bitmap, 0, 0, width, height);
          const url = canvas.toDataURL('image/png');
          previewUrlRef.current = url;
          setPreview({ key, url, overlayUrl: createOverlayUrl(canvas) });
          setReady(true);
        }
        bitmap.close();
      } catch (error) {
        if (!cancelled) { setReady(true); setStatus(error instanceof Error ? error.message : String(error)); }
      }
    })();
    return () => { cancelled = true; if (previewRequest.current !== null) cancelAnimationFrame(previewRequest.current); previewRequest.current = null; };
  }, [key]);

  function createOverlayUrl(mask: HTMLCanvasElement) {
    const context = mask.getContext('2d');
    if (!context) return '';
    const pixels = context.getImageData(0, 0, mask.width, mask.height);
    let hasPaint = false;
    for (let index = 0; index < pixels.data.length; index += 4) {
      const erased = 255 - pixels.data[index + 3];
      pixels.data[index] = 255;
      pixels.data[index + 1] = 58;
      pixels.data[index + 2] = 78;
      pixels.data[index + 3] = erased;
      hasPaint ||= erased > 0;
    }
    if (!hasPaint) return '';
    const overlay = document.createElement('canvas');
    overlay.width = mask.width;
    overlay.height = mask.height;
    overlay.getContext('2d')?.putImageData(pixels, 0, 0);
    return overlay.toDataURL('image/png');
  }

  function refreshPreview() {
    const canvas = canvasRef.current;
    if (!canvas || !keyRef.current) return '';
    const url = canvas.toDataURL('image/png');
    previewUrlRef.current = url;
    setPreview({ key: keyRef.current, url, overlayUrl: createOverlayUrl(canvas) });
    return url;
  }
  function schedulePreview() {
    if (previewRequest.current !== null) return;
    previewRequest.current = requestAnimationFrame(() => { previewRequest.current = null; refreshPreview(); });
  }
  function queueSave(url: string) {
    if (!projectId) return;
    const id = projectId;
    const task = saveQueue.current.catch(() => {}).then(async () => {
      if (custom) await custom.save(url);
      else {
        const response = url
          ? await fetch(`${api}/projects/${id}/mask`, { method: 'PUT', headers, body: await (await fetch(url)).blob() })
          : await fetch(`${api}/projects/${id}/mask`, { method: 'DELETE', headers: { 'X-Chroma-Save': '1' } });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Mask save failed (HTTP ${response.status}).`);
        }
      }
    });
    saveQueue.current = task.catch(() => {});
    onPendingSave(task);
    setStatus(custom ? 'Updating frame mask…' : 'Saving mask…');
    void task.then(() => { if (keyRef.current.startsWith(`${id}:`)) setStatus(custom ? 'Mask ready to save with this frame' : 'Mask saved'); }).catch(error => { if (keyRef.current.startsWith(`${id}:`)) setStatus(error.message); });
  }
  function point(event: React.PointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(width, (event.clientX - rect.left) / rect.width * width)), y: Math.max(0, Math.min(height, (event.clientY - rect.top) / rect.height * height)) };
  }
  function setSelection(points: MaskSelectionPoint[] | null) {
    if (!points || points.length < 3) { selectionRef.current = null; return false; }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) context.lineTo(points[index].x, points[index].y);
    context.closePath();
    context.fillStyle = '#fff';
    context.fill();
    const pixels = context.getImageData(0, 0, width, height).data;
    const coverage = new Uint8Array(width * height);
    let hasArea = false;
    for (let index = 0; index < coverage.length; index++) {
      coverage[index] = pixels[index * 4 + 3];
      hasArea ||= coverage[index] > 0;
    }
    if (!hasArea) { selectionRef.current = null; return false; }
    selectionRef.current = coverage;
    return true;
  }
  function applySelection(selectionAction: BrushAction) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    const selection = selectionRef.current;
    if (!canvas || !context || !selection || !ready) return;
    let pixels: ImageData;
    try { pixels = context.getImageData(0, 0, canvas.width, canvas.height); }
    catch { setStatus('Could not read the mask canvas.'); return; }
    let changed = false;
    for (let index = 0; index < selection.length; index++) {
      const amount = selection[index];
      if (!amount) continue;
      const pixel = index * 4;
      const base = pixels.data[pixel + 3];
      pixels.data[pixel] = 255;
      pixels.data[pixel + 1] = 255;
      pixels.data[pixel + 2] = 255;
      const nextAlpha = selectionAction === 'erase'
        ? Math.round(base * (1 - amount / 255))
        : Math.round(base + (255 - base) * amount / 255);
      if (nextAlpha === base) continue;
      pixels.data[pixel + 3] = nextAlpha;
      changed = true;
    }
    if (!changed) { setStatus('No mask pixels changed'); return; }
    undoRef.current.push(previewUrlRef.current);
    if (undoRef.current.length > 10) undoRef.current.shift();
    context.putImageData(pixels, 0, 0);
    queueSave(refreshPreview());
  }
  function dab(stroke: Stroke, x: number, y: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { radius, pixels, originalAlpha, coverage } = stroke;
    const left = Math.max(0, Math.floor(x - radius));
    const right = Math.min(canvas.width - 1, Math.ceil(x + radius));
    const top = Math.max(0, Math.floor(y - radius));
    const bottom = Math.min(canvas.height - 1, Math.ceil(y + radius));
    for (let py = top; py <= bottom; py++) for (let px = left; px <= right; px++) {
      const position = py * canvas.width + px;
      const selectionAmount = selectionRef.current?.[position] ?? 255;
      if (!selectionAmount) continue;
      const amount = Math.round(selectionAmount * brushOpacity(Math.hypot(px + .5 - x, py + .5 - y), radius, stroke.edge, stroke.softness));
      if (amount <= coverage[position]) continue;
      coverage[position] = amount;
      const pixel = position * 4;
      const base = originalAlpha[position];
      pixels.data[pixel] = 255;
      pixels.data[pixel + 1] = 255;
      pixels.data[pixel + 2] = 255;
      const nextAlpha = stroke.action === 'erase'
        ? Math.round(base * (1 - amount / 255))
        : Math.round(base + (255 - base) * amount / 255);
      if (nextAlpha === pixels.data[pixel + 3]) continue;
      pixels.data[pixel + 3] = nextAlpha;
      stroke.changed = true;
    }
  }
  function paintStroke(stroke: Stroke, from: Cursor, to: Cursor) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const left = Math.max(0, Math.floor(Math.min(from.x, to.x) - stroke.radius));
    const top = Math.max(0, Math.floor(Math.min(from.y, to.y) - stroke.radius));
    const right = Math.min(canvas.width, Math.ceil(Math.max(from.x, to.x) + stroke.radius));
    const bottom = Math.min(canvas.height, Math.ceil(Math.max(from.y, to.y) + stroke.radius));
    canvas.getContext('2d')?.putImageData(stroke.pixels, 0, 0, left, top, right - left, bottom - top);
  }
  function onPointerDown(event: React.PointerEvent<HTMLElement>) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (event.button !== 0 || !ready || !canvas || !context) return;
    let pixels: ImageData;
    try { pixels = context.getImageData(0, 0, canvas.width, canvas.height); }
    catch { setStatus('Could not read the mask canvas.'); return; }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    undoRef.current.push(previewUrlRef.current);
    if (undoRef.current.length > 10) undoRef.current.shift();
    const position = point(event);
    const originalAlpha = new Uint8Array(canvas.width * canvas.height);
    for (let index = 0; index < originalAlpha.length; index++) originalAlpha[index] = pixels.data[index * 4 + 3];
    const stroke: Stroke = { pointerId: event.pointerId, changed: false, ...position, action, edge, softness, radius: effectiveBrushSize / 2, pixels, originalAlpha, coverage: new Uint8Array(originalAlpha.length) };
    strokeRef.current = stroke;
    setCursor(position);
    dab(stroke, position.x, position.y);
    paintStroke(stroke, position, position);
    if (stroke.changed) schedulePreview();
  }
  function onPointerMove(event: React.PointerEvent<HTMLElement>) {
    const position = point(event);
    setCursor(position);
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    const from = { x: stroke.x, y: stroke.y };
    const distance = Math.hypot(position.x - from.x, position.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, stroke.radius / 4)));
    for (let index = 1; index <= steps; index++) dab(stroke, from.x + (position.x - from.x) * index / steps, from.y + (position.y - from.y) * index / steps);
    stroke.x = position.x;
    stroke.y = position.y;
    paintStroke(stroke, from, position);
    if (stroke.changed) schedulePreview();
  }
  function onPointerEnd(event: React.PointerEvent<HTMLElement>) {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    strokeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (previewRequest.current !== null) { cancelAnimationFrame(previewRequest.current); previewRequest.current = null; }
    if (stroke.changed) queueSave(refreshPreview());
    else { undoRef.current.pop(); setCursor(null); setStatus('No mask pixels changed'); }
  }
  async function undo() {
    if (!ready || !canvasRef.current || !undoRef.current.length) return;
    const snapshot = undoRef.current.pop() || '';
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (snapshot) {
      const bitmap = await createImageBitmap(await (await fetch(snapshot)).blob());
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      queueSave(refreshPreview());
    } else {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      previewUrlRef.current = '';
      setPreview({ key: keyRef.current, url: '', overlayUrl: '' });
      queueSave('');
    }
  }
  function reset() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !ready) return;
    undoRef.current.push(previewUrlRef.current);
    if (undoRef.current.length > 10) undoRef.current.shift();
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    previewUrlRef.current = '';
    setPreview({ key: keyRef.current, url: '', overlayUrl: '' });
    queueSave('');
  }
  return {
    previewUrl: preview.key === key ? preview.url : '', overlayUrl: preview.key === key ? preview.overlayUrl : '', ready, status, brushSize: effectiveBrushSize, maxBrushSize,
    setBrushSize, edge, setEdge, softness, setSoftness, brushStamps, action, setAction, cursor, setCursor, canUndo: undoRef.current.length > 0,
    onPointerDown, onPointerMove, onPointerEnd, setSelection, applySelection, undo, reset,
  };
}
