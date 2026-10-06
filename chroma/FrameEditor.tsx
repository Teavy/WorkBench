import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play, Plus, SkipBack, SkipForward } from 'lucide-react';
import SingleFrameEditor from './SingleFrameEditor';

export type FrameEdit = { x: number; y: number; zoom: number; maskId: string | null };
export type FrameSlot = { frame: number | null; edit?: FrameEdit };
type BlendKind = 'loop' | 'pair' | 'blend';
export type FramePreview = { projectId: string; editedSrc: string; edit?: FrameEdit; blendKind: BlendKind | null; index: number; count: number; originalCount: number; width: number; height: number };
export type Project = { id: string; name: string; status: string; progress: number; error: string; frameCount: number; blendFrameCount?: number; derivedFrameKinds?: BlendKind[]; blendUndoCount?: number; loopBlendUndo?: FrameSlot[] | null; width: number; height: number; slots: FrameSlot[]; config: { fps: number }; outputDirectory: string; updatedAt: string };
type PreviewSeek = { projectId: string; index: number; token: number };
type Props = { projectId: string | null; sourceRevision: number; config: Record<string, unknown>; disabled: boolean; editable: boolean; needsRegeneration: boolean; settingsChanged: boolean; legacyFrameTiming: boolean; previewSeek: PreviewSeek | null; playing: boolean; globalMaskUrl: string; backgroundUrl: string; backgroundOriginalSize: boolean; onPlayingChange: React.Dispatch<React.SetStateAction<boolean>>; onRestoreGeneratedSettings: () => void; onPreview: (preview: FramePreview | null) => void; onProjectChange: (project: Project | null) => void; onPendingSave: (pending: Promise<void>) => void };
const api = '/api/chroma';
const maxEditedSlots = (originalCount: number) => originalCount + 10000;
const headers = { 'Content-Type': 'application/json', 'X-Chroma-Save': '1' };
const sourceUrl = (id: string, frame: number) => `${api}/projects/${id}/frames/${frame}`;
const blendKindFor = (project: Project, frame: number | null): BlendKind | null => frame !== null && frame > project.frameCount ? project.derivedFrameKinds?.[frame - project.frameCount - 1] || 'blend' : null;
async function responseError(response: Response) { const data = await response.json().catch(() => ({})); return new Error(data.error || `HTTP ${response.status}`); }

export default function FrameEditor({ projectId, sourceRevision, config, disabled, editable, needsRegeneration, settingsChanged, legacyFrameTiming, previewSeek, playing, globalMaskUrl, backgroundUrl, backgroundOriginalSize, onPlayingChange: setPlaying, onRestoreGeneratedSettings, onPreview, onProjectChange, onPendingSave }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [selected, setSelected] = useState(0);
  const [selection, setSelection] = useState<number[]>([0]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [chooser, setChooser] = useState(false);
  const [chooserFilter, setChooserFilter] = useState<'all' | 'unused' | 'once' | 'reused'>('all');
  const [expanded, setExpanded] = useState(true);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [copiedSlots, setCopiedSlots] = useState<{ projectId: string; slots: FrameSlot[] } | null>(null);
  const [overlapFrames, setOverlapFrames] = useState(4);
  const [betweenFrames, setBetweenFrames] = useState(3);
  const [lastDeleted, setLastDeleted] = useState<{ projectId: string; slots: { index: number; slot: FrameSlot }[] } | null>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const saveError = useRef<Error | null>(null);
  const dragIndices = useRef<number[]>([]);
  const frameStripRef = useRef<HTMLDivElement | null>(null);
  const selectionAnchor = useRef(0);
  const [dropTarget, setDropTarget] = useState<{ index: number; after: boolean } | null>(null);
  const currentId = useRef<string | null>(null);
  const loadRevision = useRef(0);
  const activeSlot = project?.slots[selected] || null;
  const canPaste = Boolean(editable && project && copiedSlots?.projectId === project.id && project.slots.length + copiedSlots.slots.length <= maxEditedSlots(project.frameCount));
  const maxOverlap = project ? Math.min(60, Math.floor((project.slots.length - 1) / 2)) : 0;
  const effectiveOverlap = Math.min(Math.max(1, overlapFrames), maxOverlap);
  const sourceUsage = project ? project.slots.reduce((counts, slot) => {
    if (slot.frame !== null && slot.frame >= 1 && slot.frame <= project.frameCount) counts[slot.frame]++;
    return counts;
  }, Array<number>(project.frameCount + 1).fill(0)) : [];
  const usageCounts = sourceUsage.slice(1).reduce((counts, references) => {
    if (references === 0) counts.unused++;
    else if (references === 1) counts.once++;
    else counts.reused++;
    return counts;
  }, { unused: 0, once: 0, reused: 0 });

  async function loadProject(id: string) {
    const revision = loadRevision.current;
    const response = await fetch(`${api}/projects/${id}`, { cache: 'no-store' });
    if (!response.ok) throw await responseError(response);
    const loaded: Project = await response.json();
    if (currentId.current === id && loadRevision.current === revision) setProject(loaded);
    return loaded;
  }
  useEffect(() => {
    loadRevision.current++;
    const revision = loadRevision.current;
    currentId.current = projectId;
    setProject(null);
    setSelected(0);
    setSelection([0]);
    selectionAnchor.current = 0;
    setPlaying(false);
    setLastDeleted(null);
    setCopiedSlots(null);
    setEditingIndex(null);
    setChooserFilter('all');
    setMessage('');
    saveQueue.current = Promise.resolve();
    onPendingSave(Promise.resolve());
    if (projectId) void loadProject(projectId).catch(error => { if (currentId.current === projectId && loadRevision.current === revision) setMessage(error.message); });
  }, [projectId, sourceRevision]);
  useEffect(() => {
    if (!project || !['uploaded', 'generating'].includes(project.status)) return;
    const timer = window.setInterval(() => {
      void loadProject(project.id).catch(error => setMessage(error.message));
    }, 700);
    return () => window.clearInterval(timer);
  }, [project?.id, project?.status]);
  useEffect(() => {
    if (!previewSeek || !project || project.status !== 'ready' || previewSeek.projectId !== project.id) return;
    const index = Math.max(0, Math.min(project.slots.length - 1, previewSeek.index));
    setSelected(index);
    setSelection([index]);
    selectionAnchor.current = index;
  }, [previewSeek?.token, project?.id, project?.slots.length]);
  useEffect(() => { if (playing) setSelection([selected]); }, [playing, selected]);
  useEffect(() => { if (!editable) { setPlaying(false); setChooser(false); dragIndices.current = []; setDropTarget(null); } }, [editable]);
  useEffect(() => {
    const strip = frameStripRef.current;
    if (!strip) return;
    const scrollFramesWithWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      const maxScroll = strip.scrollWidth - strip.clientWidth;
      if (maxScroll <= 0) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : 1;
      const slots = strip.querySelectorAll<HTMLElement>('.chroma-frame-slot');
      const frameStep = slots.length > 1 ? slots[1].offsetLeft - slots[0].offsetLeft : 93;
      const rawStep = event.deltaY * unit;
      const smoothInput = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(event.deltaY) < 20;
      const step = smoothInput ? rawStep : Math.sign(rawStep) * Math.max(Math.abs(rawStep), frameStep);
      const next = Math.max(0, Math.min(maxScroll, strip.scrollLeft + step));
      if (next === strip.scrollLeft) return;
      event.preventDefault();
      strip.scrollLeft = next;
    };
    strip.addEventListener('wheel', scrollFramesWithWheel, { passive: false });
    return () => strip.removeEventListener('wheel', scrollFramesWithWheel);
  }, [project?.status, expanded]);
  useEffect(() => {
    onProjectChange(project?.status === 'ready' ? project : null);
    if (!project || project.status !== 'ready') { onPreview(null); return; }
    const index = Math.min(selected, project.slots.length - 1);
    const slot = project.slots[index] || null;
    onPreview({ projectId: project.id, editedSrc: slot?.frame ? sourceUrl(project.id, slot.frame) : '', edit: slot?.edit, blendKind: blendKindFor(project, slot?.frame ?? null), index, count: project.slots.length, originalCount: project.frameCount, width: project.width, height: project.height });
  }, [project, selected, onPreview, onProjectChange]);

  async function generate() {
    if (!projectId || busy || disabled || (project?.status === 'ready' && !editable)) return;
    if (project?.status === 'ready' && !window.confirm('Regenerate this file’s transparent frames? This replaces its edited frame sequence.')) return;
    setBusy(true);
    setLastDeleted(null);
    setCopiedSlots(null);
    setPlaying(false);
    setSelected(0);
    setSelection([0]);
    selectionAnchor.current = 0;
    setMessage('Generating transparent PNG frames…');
    try {
      const response = await fetch(`${api}/projects/${projectId}/generate`, { method: 'POST', headers, body: JSON.stringify({ config }) });
      if (!response.ok) throw await responseError(response);
      const created: Project = await response.json();
      setProject(created);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function changeSlots(next: FrameSlot[], keepUndo = false) {
    if (!editable || busy || !project || next.length < 1 || next.length > maxEditedSlots(project.frameCount)) return;
    if (!keepUndo) setLastDeleted(null);
    const id = project.id;
    setProject(current => current?.id === id ? { ...current, slots: next, loopBlendUndo: null, blendUndoCount: 0 } : current);
    setMessage('Saving edits…');
    const pending = saveQueue.current.catch(() => {}).then(async () => {
      const response = await fetch(`${api}/projects/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ slots: next }) });
      if (!response.ok) throw await responseError(response);
      saveError.current = null;
      if (currentId.current === id) setMessage('Edits saved');
    }).catch(error => { saveError.current = error; if (currentId.current === id) setMessage(`Save failed: ${error.message}`); throw error; });
    onPendingSave(pending);
    saveQueue.current = pending.catch(() => {});
  }
  function changeSelectedSlots(frame: number | null) {
    if (!project) return;
    const targets = new Set(selection);
    changeSlots(project.slots.map((slot, position) => targets.has(position) ? { frame } : slot));
  }
  async function saveSingleFrameEdit(index: number, edit: FrameEdit | undefined) {
    if (!project || !editable || busy) throw new Error('Frame editing is unavailable.');
    const id = project.id;
    setBusy(true);
    const task = saveQueue.current.catch(() => {}).then(async () => {
      if (saveError.current) throw saveError.current;
      const slots = project.slots.map((slot, position) => position === index ? edit ? { ...slot, edit } : { frame: slot.frame } : slot);
      const response = await fetch(`${api}/projects/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ slots }) });
      if (!response.ok) throw await responseError(response);
      const saved: Project = await response.json();
      if (currentId.current === id) { setProject(saved); setLastDeleted(null); setMessage('Single-frame edit saved'); }
    });
    saveQueue.current = task;
    onPendingSave(task);
    try { await task; } finally { setBusy(false); }
  }
  function insertBlankSlot(index: number) {
    if (!project || project.slots.length >= maxEditedSlots(project.frameCount)) return;
    setPlaying(false);
    const next = [...project.slots];
    next.splice(index, 0, { frame: null });
    changeSlots(next);
    setSelected(index);
    setSelection([index]);
    selectionAnchor.current = index;
  }
  function reverseSelectedSlots() {
    if (!project || selection.length < 2) return;
    setPlaying(false);
    const next = [...project.slots];
    const reversed = selection.map(index => project.slots[index]).reverse();
    selection.forEach((index, offset) => { next[index] = reversed[offset]; });
    changeSlots(next);
  }
  function copySelectedSlots() {
    if (!editable || !project || !selection.length) return;
    setPlaying(false);
    const slots = [...selection].sort((a, b) => a - b).map(index => ({ ...project.slots[index] }));
    setCopiedSlots({ projectId: project.id, slots });
    setMessage(`${slots.length} frame${slots.length === 1 ? '' : 's'} copied`);
  }
  function pasteCopiedSlots() {
    if (!project || !copiedSlots || !canPaste) return;
    setPlaying(false);
    const insertAt = Math.min(selected + 1, project.slots.length);
    const next = [...project.slots];
    next.splice(insertAt, 0, ...copiedSlots.slots.map(slot => ({ ...slot, edit: slot.edit ? { ...slot.edit } : undefined })));
    changeSlots(next);
    const pasted = copiedSlots.slots.map((_, offset) => insertAt + offset);
    const last = pasted[pasted.length - 1];
    setSelection(pasted);
    setSelected(last);
    selectionAnchor.current = last;
  }
  function isTimelineTarget(target: EventTarget) {
    return target instanceof HTMLElement && Boolean(target.closest('.chroma-slot-toolbar, .chroma-frame-strip')) && !target.closest('input,textarea,select,[contenteditable="true"]');
  }
  function onEditorKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (!editable || busy || !project || project.status !== 'ready' || !expanded || chooser || event.altKey || !(event.ctrlKey || event.metaKey) || !isTimelineTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'c') { event.preventDefault(); copySelectedSlots(); }
    if (key === 'v' && canPaste) { event.preventDefault(); pasteCopiedSlots(); }
  }
  function onEditorCopy(event: React.ClipboardEvent<HTMLElement>) {
    if (editable && project?.status === 'ready' && expanded && !chooser && isTimelineTarget(event.target)) copySelectedSlots();
  }
  function onEditorPaste(event: React.ClipboardEvent<HTMLElement>) {
    if (!chooser && expanded && canPaste && isTimelineTarget(event.target)) { event.preventDefault(); pasteCopiedSlots(); }
  }
  function selectSlot(index: number, shift: boolean, additive: boolean, empty: boolean) {
    setPlaying(false);
    if (additive) {
      const next = selection.includes(index) && selection.length > 1 ? selection.filter(value => value !== index) : [...new Set([...selection, index])].sort((a, b) => a - b);
      const active = next.includes(index) ? index : next[next.length - 1];
      setSelected(active);
      setSelection(next);
      selectionAnchor.current = active;
      return;
    }
    setSelected(index);
    if (shift) {
      const start = Math.min(selectionAnchor.current, index);
      const end = Math.max(selectionAnchor.current, index);
      setSelection(Array.from({ length: end - start + 1 }, (_, offset) => start + offset));
    } else {
      selectionAnchor.current = index;
      setSelection([index]);
      if (empty) setChooser(true);
    }
  }
  function stepFrame(direction: -1 | 1) {
    if (!project) return;
    setPlaying(false);
    const next = Math.max(0, Math.min(project.slots.length - 1, selected + direction));
    setSelected(next);
    setSelection([next]);
    selectionAnchor.current = next;
  }
  function moveSelectedSlots(target: number) {
    if (!project || !dragIndices.current.length) return;
    const moving = [...dragIndices.current].sort((a, b) => a - b);
    if (target >= moving[0] && target <= moving[moving.length - 1] + 1) return;
    const movingSet = new Set(moving);
    const remaining = project.slots.filter((_, index) => !movingSet.has(index));
    const insertion = Math.max(0, Math.min(remaining.length, target - moving.filter(index => index < target).length));
    const next = [...remaining.slice(0, insertion), ...moving.map(index => project.slots[index]), ...remaining.slice(insertion)];
    if (next.every((slot, index) => slot === project.slots[index])) return;
    changeSlots(next);
    const nextSelection = moving.map((_, offset) => insertion + offset);
    setSelection(nextSelection);
    const activeOffset = moving.indexOf(selected);
    const nextActive = insertion + Math.max(0, activeOffset);
    setSelected(nextActive);
    selectionAnchor.current = nextSelection[0];
  }
  function deleteSelectedSlots() {
    if (!project || selection.length >= project.slots.length) return;
    setPlaying(false);
    const removed = new Set(selection);
    changeSlots(project.slots.filter((_, position) => !removed.has(position)), true);
    setLastDeleted({ projectId: project.id, slots: selection.map(index => ({ index, slot: project.slots[index] })) });
    const next = Math.min(selection[0], project.slots.length - selection.length - 1);
    setSelected(next);
    setSelection([next]);
    selectionAnchor.current = next;
  }
  function undoDelete() {
    if (!project || !lastDeleted || lastDeleted.projectId !== project.id || project.slots.length + lastDeleted.slots.length > maxEditedSlots(project.frameCount)) return;
    const next = [...project.slots];
    for (const { index, slot } of lastDeleted.slots) next.splice(index, 0, slot);
    changeSlots(next);
    const restored = lastDeleted.slots.map(item => item.index);
    setSelected(restored[0]);
    setSelection(restored);
    selectionAnchor.current = restored[0];
  }
  function applyLoopBlend() { onPendingSave(performLoopBlend()); }
  async function performLoopBlend() {
    if (!project || !editable || busy || needsRegeneration || maxOverlap < 1) return;
    const id = project.id;
    setPlaying(false);
    setBusy(true);
    setMessage(`Blending ${effectiveOverlap} tail/head frame pairs…`);
    try {
      await saveQueue.current;
      if (saveError.current) throw saveError.current;
      const response = await fetch(`${api}/projects/${id}/loop-blend`, { method: 'POST', headers, body: JSON.stringify({ overlap: effectiveOverlap }) });
      if (!response.ok) throw await responseError(response);
      const blended: Project = await response.json();
      if (currentId.current !== id) return;
      setProject(blended);
      const firstBlend = blended.slots.length - effectiveOverlap;
      setSelected(firstBlend);
      setSelection([firstBlend]);
      selectionAnchor.current = firstBlend;
      setLastDeleted(null);
      setMessage(`Loop blend added: ${effectiveOverlap} transition frames · ${blended.slots.length} frames / ${(blended.slots.length / blended.config.fps).toFixed(2)} s. The original sequence is unchanged.`);
      requestAnimationFrame(() => { const strip = frameStripRef.current; if (strip) strip.scrollLeft = Math.max(0, firstBlend * 93 - strip.clientWidth / 2); });
    } catch (error) { if (currentId.current === id) setMessage(`Loop blend failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }
  function applyBetweenBlend() { onPendingSave(performBetweenBlend()); }
  async function performBetweenBlend() {
    if (!project || !editable || busy || needsRegeneration || selection.length !== 2) return;
    const id = project.id;
    const [firstIndex, secondIndex] = [...selection].sort((a, b) => a - b);
    const steps = Math.min(Math.max(1, betweenFrames), 60);
    setPlaying(false);
    setBusy(true);
    setMessage(`Creating ${steps} transition frames between #${firstIndex + 1} and #${secondIndex + 1}…`);
    try {
      await saveQueue.current;
      if (saveError.current) throw saveError.current;
      const response = await fetch(`${api}/projects/${id}/between-blend`, { method: 'POST', headers, body: JSON.stringify({ firstIndex, secondIndex, steps }) });
      if (!response.ok) throw await responseError(response);
      const blended: Project = await response.json();
      if (currentId.current !== id) return;
      setProject(blended);
      const firstBlend = firstIndex + 1;
      setSelected(firstBlend);
      setSelection([firstBlend]);
      selectionAnchor.current = firstBlend;
      setLastDeleted(null);
      setMessage(`Inserted ${steps} transition frames after #${firstIndex + 1} · ${blended.slots.length} frames / ${(blended.slots.length / blended.config.fps).toFixed(2)} s. Existing frames remain in order.`);
      requestAnimationFrame(() => { const strip = frameStripRef.current; if (strip) strip.scrollLeft = Math.max(0, firstBlend * 93 - strip.clientWidth / 2); });
    } catch (error) { if (currentId.current === id) setMessage(`Frame blend failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }
  function undoLoopBlend() { onPendingSave(performUndoLoopBlend()); }
  async function performUndoLoopBlend() {
    if (!project || !editable || busy || !project.loopBlendUndo) return;
    const id = project.id;
    setPlaying(false);
    setBusy(true);
    try {
      await saveQueue.current;
      const response = await fetch(`${api}/projects/${id}/undo-loop-blend`, { method: 'POST', headers });
      if (!response.ok) throw await responseError(response);
      const restored: Project = await response.json();
      if (currentId.current !== id) return;
      setProject(restored);
      setSelected(0);
      setSelection([0]);
      selectionAnchor.current = 0;
      setMessage('Loop blend undone. The previous edited sequence is restored.');
    } catch (error) { if (currentId.current === id) setMessage(`Could not undo loop blend: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }
  return <section className={`chroma-frame-editor ${project?.status === 'ready' && expanded ? 'expanded' : ''} ${project?.status === 'ready' && !editable ? 'locked' : ''} ${needsRegeneration ? 'outdated' : ''} ${busy ? 'processing' : ''}`} aria-label="Frame animation editor" aria-busy={busy} onKeyDown={onEditorKeyDown} onCopy={onEditorCopy} onPaste={onEditorPaste}>
    <div className="chroma-frame-editor-header">
      <div><strong>04 / Frame animation editor</strong><span>{!projectId ? 'Select a file on the left' : project?.status === 'ready' ? editable ? `Edited sequence · ${project.slots.length} frames at ${project.config.fps} FPS · ${(project.slots.length / project.config.fps).toFixed(2)} s (original: ${project.frameCount})` : 'Original preview is active · Switch to Edited above to use the frame timeline' : 'Generate transparent PNGs for the selected file'}</span></div>
      {project?.status === 'ready' && expanded && <span className="chroma-frame-editor-help">Drag to reorder · Shift-click a range · Ctrl-click two frames · Ctrl+C copies selected · Ctrl+V pastes after active frame</span>}
      <div className="chroma-frame-editor-actions">
        {needsRegeneration && <span className="chroma-frame-regenerate-hint" role="status">{legacyFrameTiming ? 'Frame timing was corrected · Regenerate PNG frames to align them' : 'Settings changed since these PNG frames were generated'}</span>}
        {settingsChanged && <button type="button" className="chroma-restore-generated" onClick={onRestoreGeneratedSettings}>Restore generated settings</button>}
        <button type="button" className={needsRegeneration && project?.status === 'ready' && editable && !busy && !disabled ? 'chroma-regenerate-button' : ''} onClick={generate} disabled={!projectId || busy || disabled || (project?.status === 'ready' && !editable)}>{project?.status === 'ready' ? 'Regenerate PNG frames' : 'Generate PNG frames'}</button>
        {project?.status === 'ready' && <button type="button" onClick={() => { setExpanded(value => !value); setPlaying(false); }}>{expanded ? 'Close editor' : 'Open editor'}</button>}
      </div>
    </div>
    {project && !['ready', 'source-ready'].includes(project.status) && <p className="chroma-frame-editor-message">{project.status === 'error' ? project.error : `Project ${project.status}…`}</p>}
    {project?.status === 'ready' && expanded && <>
      <div className="chroma-slot-toolbar">
        <div className="chroma-frame-transport" aria-label="Animation playback controls">
          <button type="button" className="chroma-transport-button" disabled={!editable || selected === 0} onClick={() => stepFrame(-1)} aria-label="Previous frame" title="Previous frame"><SkipBack size={16} fill="currentColor"/></button>
          <button type="button" className="chroma-transport-button" disabled={!editable} onClick={() => { setSelection([selected]); setPlaying(value => !value); }} aria-label={playing ? 'Pause animation' : 'Play animation'} title={playing ? 'Pause animation' : 'Play animation'}>{playing ? <Pause size={16} fill="currentColor"/> : <Play size={16} fill="currentColor"/>}</button>
          <button type="button" className="chroma-transport-button" disabled={!editable || selected === project.slots.length - 1} onClick={() => stepFrame(1)} aria-label="Next frame" title="Next frame"><SkipForward size={16} fill="currentColor"/></button>
        </div>
        <span>Frame {selected + 1} / {project.slots.length}</span>
        {selection.length > 1 && <span className="chroma-frame-selection-count">{selection.length} frames selected</span>}
        {selection.length === 1 && activeSlot?.frame && <button type="button" onClick={() => { setPlaying(false); setEditingIndex(selected); }} disabled={!editable || busy}>Edit this frame</button>}
        <button onClick={() => { setPlaying(false); setChooser(true); }} disabled={!editable}>{selection.length > 1 ? 'Replace selected frames' : activeSlot?.frame ? 'Replace frame' : 'Assign frame'}</button>
        <button onClick={() => changeSelectedSlots(null)} disabled={!editable || !selection.some(index => project.slots[index]?.frame)}>{selection.length > 1 ? 'Clear frames' : 'Clear frame'}</button>
        {selection.length > 1 && <button onClick={reverseSelectedSlots} disabled={!editable} title="Reverse the order of selected frames">Reverse selected frames</button>}
        <button onClick={deleteSelectedSlots} disabled={!editable || selection.length >= project.slots.length} title="Remove selected time slots and shorten the edited animation">{selection.length > 1 ? 'Delete frames' : 'Delete frame'}</button>
        {lastDeleted?.projectId === project.id && <button onClick={undoDelete} disabled={!editable}>Undo delete</button>}
        <div className="chroma-loop-blend" title="Ctrl-click two frames, then insert new blended transition frames immediately after the earlier one. Existing frames stay in order; choosing adjacent frames gives a direct transition.">
          <label htmlFor="chroma-between-frames">Selected pair</label>
          <input id="chroma-between-frames" type="number" min="1" max="60" value={betweenFrames} onChange={event => setBetweenFrames(Math.min(60, Math.max(1, Number(event.target.value) || 1)))} disabled={!editable || busy} aria-label="Transition frames to insert"/>
          <span>{selection.length === 2 ? `#${selection[0] + 1} → #${selection[1] + 1} · +${(betweenFrames / project.config.fps).toFixed(2)} s` : 'new frames'}</span>
          <button type="button" onClick={applyBetweenBlend} disabled={!editable || busy || needsRegeneration || selection.length !== 2 || project.slots.length + betweenFrames > maxEditedSlots(project.frameCount)} title="Blend the two selected frames and insert the result after the earlier frame">Blend pair</button>
        </div>
        <div className="chroma-loop-blend" title="Blend the last K frames with the first K frames, pair by pair. The edited sequence becomes K frames shorter; the original sequence is kept.">
          <label htmlFor="chroma-loop-overlap">Loop blend</label>
          <input id="chroma-loop-overlap" type="number" min="1" max={Math.max(1, maxOverlap)} value={maxOverlap ? effectiveOverlap : 1} onChange={event => setOverlapFrames(Number(event.target.value) || 1)} disabled={!editable || busy || maxOverlap < 1} aria-label="Loop overlap frames"/>
          <span>pairs · −{maxOverlap ? effectiveOverlap : 0} frames</span>
          <button type="button" onClick={applyLoopBlend} disabled={!editable || busy || needsRegeneration || maxOverlap < 1}>Apply</button>
        </div>
        {project.loopBlendUndo && <button type="button" onClick={undoLoopBlend} disabled={!editable || busy}>Undo blend</button>}
      </div>
      <div ref={frameStripRef} className="chroma-frame-strip" role="list" aria-label="Edited frame sequence">
        {project.slots.map((slot, index) => {
          const derived = slot.frame !== null && slot.frame > project.frameCount;
          const blendKind = blendKindFor(project, slot.frame);
          const imageNumber = slot.frame === null ? null : derived ? slot.frame - project.frameCount : slot.frame;
          const imageLabel = imageNumber === null ? 'Empty' : `${blendKind ? `${blendKind === 'loop' ? 'Loop' : blendKind === 'pair' ? 'Pair' : 'Blend'} ` : ''}#${String(imageNumber).padStart(3, '0')}`;
          const imageFilename = imageNumber === null ? 'Empty slot' : `${derived ? 'derived/' : ''}${String(imageNumber).padStart(6, '0')}.png`;
          const previousFrame = project.slots[index - 1]?.frame;
          const sourceGap = typeof previousFrame === 'number' && typeof slot.frame === 'number' && previousFrame <= project.frameCount && slot.frame <= project.frameCount && Math.abs(slot.frame - previousFrame) > 1;
          const sourceGapLabel = sourceGap ? `Source image numbers jump from #${String(previousFrame).padStart(3, '0')} to #${String(slot.frame).padStart(3, '0')}` : '';
          return <div key={index} className={`chroma-frame-slot ${blendKind || ''} ${index === selected && selection.length === 1 ? 'active' : ''}`}>
          {sourceGap && <span className="chroma-frame-source-gap" role="img" aria-label={sourceGapLabel} title={sourceGapLabel}>!</span>}
          <span className={`chroma-frame-image-name ${imageNumber === null ? 'empty' : ''}`} title={imageFilename} aria-label={`Image ${imageFilename}${blendKind ? `, ${blendKind} blend` : ''}`}>{imageLabel}</span>
          {index === selected && selection.length === 1 && editable && <button type="button" className="chroma-insert-frame before" onClick={() => insertBlankSlot(index)} disabled={project.slots.length >= maxEditedSlots(project.frameCount)} aria-label={`Insert blank frame before frame ${index + 1}`} title="Insert blank frame before"><Plus size={14}/></button>}
          <button className={`chroma-frame-tile ${index === selected ? 'selected' : ''} ${selection.includes(index) ? 'multi-selected' : ''} ${dropTarget?.index === index ? dropTarget.after ? 'drop-after' : 'drop-before' : ''}`} role="listitem" draggable={editable} disabled={!editable} aria-pressed={selection.includes(index)} onDragStart={event => { if (!editable) return; const indices = selection.includes(index) ? selection : [index]; dragIndices.current = indices; if (!selection.includes(index)) { setSelected(index); setSelection([index]); selectionAnchor.current = index; } event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); setPlaying(false); }} onDragOver={event => { if (!editable || !dragIndices.current.length) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget({ index, after: event.clientX >= event.currentTarget.getBoundingClientRect().left + event.currentTarget.getBoundingClientRect().width / 2 }); }} onDragEnd={() => { dragIndices.current = []; setDropTarget(null); }} onDrop={event => { if (!editable) return; event.preventDefault(); const after = event.clientX >= event.currentTarget.getBoundingClientRect().left + event.currentTarget.getBoundingClientRect().width / 2; moveSelectedSlots(index + Number(after)); dragIndices.current = []; setDropTarget(null); }} onClick={event => selectSlot(index, event.shiftKey, event.ctrlKey || event.metaKey, slot.frame === null)} onDoubleClick={event => { if (editable && !event.shiftKey && !event.ctrlKey && !event.metaKey && slot.frame !== null) { setSelected(index); setSelection([index]); setEditingIndex(index); } }} aria-label={`Frame slot ${index + 1}${slot.frame === null ? ', empty' : slot.frame > project.frameCount ? ', blended frame' : `, source frame ${slot.frame}`}`}>
          <span className="chroma-frame-tile-image checker">{slot.frame ? <span className="chroma-frame-thumb-content" style={slot.edit?.maskId ? { maskImage: `url(${api}/projects/${project.id}/frame-masks/${slot.edit.maskId})`, WebkitMaskImage: `url(${api}/projects/${project.id}/frame-masks/${slot.edit.maskId})`, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' } : undefined}><img src={sourceUrl(project.id, slot.frame)} loading="lazy" alt="" draggable={false} style={slot.edit ? { transform: `translate(${slot.edit.x * 100}%, ${slot.edit.y * 100}%) scale(${slot.edit.zoom})` } : undefined}/></span>: <b>+</b>}{blendKind && <span className="chroma-frame-blend-marker" aria-hidden="true">{blendKind === 'loop' ? 'L' : blendKind === 'pair' ? 'P' : 'B'}</span>}{slot.edit && <span className="chroma-frame-edited-marker" title="Single-frame edit" aria-label="Single-frame edit">✎</span>}</span><small>{index + 1}</small>
          </button>
          {index === selected && selection.length === 1 && editable && <button type="button" className="chroma-insert-frame after" onClick={() => insertBlankSlot(index + 1)} disabled={project.slots.length >= maxEditedSlots(project.frameCount)} aria-label={`Insert blank frame after frame ${index + 1}`} title="Insert blank frame after"><Plus size={14}/></button>}
        </div>;
        })}
      </div>
    </>}
    {message && <p className="chroma-frame-editor-message" role="status">{message}</p>}
    {editingIndex !== null && project?.status === 'ready' && project.slots[editingIndex] && <SingleFrameEditor key={`${project.id}:${editingIndex}`} project={project} index={editingIndex} globalMaskUrl={globalMaskUrl} backgroundUrl={backgroundUrl} backgroundOriginalSize={backgroundOriginalSize} onSave={saveSingleFrameEdit} onClose={() => setEditingIndex(null)} onNavigate={setEditingIndex}/>}
    {chooser && project?.status === 'ready' && <div className="chroma-frame-chooser-backdrop" onClick={() => setChooser(false)}>
      <div className="chroma-frame-chooser" role="dialog" aria-modal="true" aria-label="Choose source frame" onClick={event => event.stopPropagation()}>
        <div className="chroma-frame-chooser-header"><strong>Choose a transparent source frame{selection.length > 1 ? ` for ${selection.length} slots` : ''}</strong><button onClick={() => setChooser(false)}>Close</button></div>
        <div className="chroma-frame-chooser-filters" role="group" aria-label="Filter source frames by edited-sequence usage">
          {([['all', 'All', project.frameCount], ['unused', 'Unused', usageCounts.unused], ['once', 'Used once', usageCounts.once], ['reused', 'Used multiple times', usageCounts.reused]] as const).map(([filter, label, count]) => <button key={filter} type="button" className={chooserFilter === filter ? 'active' : ''} aria-pressed={chooserFilter === filter} onClick={() => setChooserFilter(filter)}>{label} <b>{count}</b></button>)}
        </div>
        <div className="chroma-frame-chooser-grid">{Array.from({ length: project.frameCount }, (_, index) => {
          const references = sourceUsage[index + 1];
          const category = references === 0 ? 'unused' : references === 1 ? 'once' : 'reused';
          if (chooserFilter !== 'all' && chooserFilter !== category) return null;
          const status = references === 0 ? 'Unused' : references === 1 ? 'Used once' : `Used ${references} times`;
          return <button key={index} type="button" className={`chroma-frame-chooser-item ${category}`} aria-label={`Source frame ${index + 1}, ${status.toLowerCase()}`} title={`${String(index + 1).padStart(6, '0')}.png · ${status}`} onClick={() => { changeSelectedSlots(index + 1); setChooser(false); }}><img src={sourceUrl(project.id, index + 1)} loading="lazy" alt=""/><strong>#{index + 1}</strong><span>{status}</span></button>;
        })}</div>
        {chooserFilter !== 'all' && usageCounts[chooserFilter] === 0 && <p className="chroma-frame-chooser-empty">No frames in this group.</p>}
      </div>
    </div>}
  </section>;
}
