import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Brush, Check, ChevronLeft, ChevronRight, Crop, Eraser, Film, FolderOpen, Move, Pause, Play, Plus, RefreshCw, RotateCcw, SkipBack, SkipForward, Trash2, Upload, X } from 'lucide-react';
import FrameEditor, { type FramePreview, type Project } from './FrameEditor';
import { useOutputMask } from './useOutputMask';
import './chroma.css';

type Settings = { color: string; similarity: number; blend: number; fps: number; size: string; width: number; height: number; squareMode: 'crop' | 'pad'; cropScale: number; cropX: number; cropY: number; foregroundZoom: number; foregroundX: number; foregroundY: number };
type FileProfile = { settings: Settings; sourceFps: number; frame: number; outputFrame: number | null; widthDraft: string; heightDraft: string; outputDirectory: string; backgroundUrl: string; backgroundName: string; backgroundOriginalSize: boolean };
type FrameRange = { start: number; end: number | null };
type FileState = { status: string; progress: number; error?: string };
type RecentOutput = { blob: Blob; url: string; name: string; savedPath: string };
type PreviewCache = { file: File; signature: string; url: string };
type ProjectSummary = { id: string; name: string; status: string; sourceBytes: number; sourceMissing: boolean; updatedAt: string };
const defaults: Settings = { color: '#00FF00', similarity: 0.27, blend: 0.08, fps: 20, size: 'original', width: 512, height: 512, squareMode: 'crop', cropScale: 1, cropX: 0.5, cropY: 0.5, foregroundZoom: 1, foregroundX: 0, foregroundY: 0 };
const frameTimingVersion = 2;
const newProfile = (directory = ''): FileProfile => ({ settings: { ...defaults }, sourceFps: 30, frame: 15, outputFrame: null, widthDraft: '512', heightDraft: '512', outputDirectory: directory, backgroundUrl: '', backgroundName: '', backgroundOriginalSize: true });
const api = '/api/chroma';
const saveHeaders = { 'Content-Type': 'application/json', 'X-Chroma-Save': '1' };
function savedProfileKey(id: string) { return `chroma-file-profile:${id}`; }
function profileFromProject(project: Project, directory: string): { profile: FileProfile; range: FrameRange } {
  const config = project.config as Settings & { startFrame?: number; endFrame?: number | null; sourceFps?: number; frameTimingVersion?: number };
  const { startFrame, endFrame, sourceFps, frameTimingVersion: _frameTimingVersion, ...savedSettings } = config;
  return {
    profile: { ...newProfile(project.outputDirectory || directory), settings: { ...defaults, ...savedSettings }, sourceFps: sourceFps || 30, frame: startFrame || 1, widthDraft: String(config.width || 512), heightDraft: String(config.height || 512) },
    range: { start: startFrame || 1, end: endFrame ?? null },
  };
}

async function errorFrom(response: Response) {
  const data = await response.json().catch(() => ({}));
  return new Error(data.error || `Request failed: HTTP ${response.status}`);
}

function fileKey(file: File, index: number) { return `${index}:${file.name}:${file.size}:${file.lastModified}`; }
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
function frameGenerationSignature(settings: Settings, startFrame: number, endFrame: number | null, sourceFps: number) {
  return JSON.stringify([
    settings.color.toUpperCase(), settings.similarity, settings.blend, settings.fps, settings.size,
    settings.size === 'custom' ? settings.width : null,
    settings.size === 'custom' ? settings.height : null,
    settings.size !== 'original' ? settings.squareMode : null,
    settings.size !== 'original' && settings.squareMode === 'crop' ? settings.cropScale : null,
    settings.size !== 'original' && settings.squareMode === 'crop' ? settings.cropX : null,
    settings.size !== 'original' && settings.squareMode === 'crop' ? settings.cropY : null,
    settings.foregroundZoom, settings.foregroundX, settings.foregroundY, startFrame, endFrame, sourceFps,
  ]);
}

export default function ChromaPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [selected, setSelected] = useState(0);
  const [projectIds, setProjectIds] = useState<Map<File, string>>(() => new Map());
  const [sourceRevision, setSourceRevision] = useState(0);
  const [sourceSizes, setSourceSizes] = useState<Map<File, number>>(() => new Map());
  const [detectedSourceFps, setDetectedSourceFps] = useState<Map<string, number>>(() => new Map());
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [profiles, setProfiles] = useState<Map<File, FileProfile>>(() => new Map());
  const [idleProfile, setIdleProfile] = useState<FileProfile>(() => newProfile());
  const [ranges, setRanges] = useState<Map<File, FrameRange>>(() => new Map());
  const [duration, setDuration] = useState(0);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const [sourceUrl, setSourceUrl] = useState('');
  const [frameUrl, setFrameUrl] = useState('');
  const [outputFrameCapture, setOutputFrameCapture] = useState<{ frame: number; blob: Blob } | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewStatus, setPreviewStatus] = useState('Select an MP4 to preview');
  const [outputEditOpen, setOutputEditOpen] = useState(false);
  const [foregroundDragging, setForegroundDragging] = useState(false);
  const [foregroundMoveActive, setForegroundMoveActive] = useState(false);
  const [adjustMode, setAdjustMode] = useState<'position' | 'mask'>('position');
  const [showMaskOverlay, setShowMaskOverlay] = useState(true);
  const [previewCache, setPreviewCache] = useState<PreviewCache | null>(null);
  const [animationPlaying, setAnimationPlaying] = useState(false);
  const [playbackStatus, setPlaybackStatus] = useState('');
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [previewRendering, setPreviewRendering] = useState(false);
  const [sourcePlaying, setSourcePlaying] = useState(false);
  const [cropEditing, setCropEditing] = useState(false);
  const [cropDragging, setCropDragging] = useState(false);
  const [cropDraft, setCropDraft] = useState<{ x: number; y: number } | null>(null);
  const [states, setStates] = useState<Record<string, FileState>>({});
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [missingSourceIds, setMissingSourceIds] = useState<Set<string>>(() => new Set());
  const [running, setRunning] = useState(false);
  const [defaultDirectory, setDefaultDirectory] = useState('');
  const [directoryDraft, setDirectoryDraft] = useState('');
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directoryError, setDirectoryError] = useState('');
  const [folderError, setFolderError] = useState('');
  const [directoryPicking, setDirectoryPicking] = useState(false);
  const [recentOutput, setRecentOutput] = useState<RecentOutput | null>(null);
  const [saveStatus, setSaveStatus] = useState('');
  const [rawFrameProjectPreview, setFrameProjectPreview] = useState<FramePreview | null>(null);
  const [rawFrameProject, setFrameProject] = useState<Project | null>(null);
  const [previewOrder, setPreviewOrder] = useState<'original' | 'edited'>('original');
  const [originalPreviewIndex, setOriginalPreviewIndex] = useState(0);
  const [originalPlaying, setOriginalPlaying] = useState(false);
  const [editedPlaying, setEditedPlaying] = useState(false);
  const [editedPreviewSeek, setEditedPreviewSeek] = useState<{ projectId: string; index: number; token: number } | null>(null);
  const editedPlayhead = useRef(0);
  const editedSeekToken = useRef(0);
  const [previewCue, setPreviewCue] = useState<{ order: 'original' | 'edited'; key: number } | null>(null);
  const [exportOrder, setExportOrder] = useState<'original' | 'edited'>('original');
  const [exportFormat, setExportFormat] = useState<'webp' | 'png' | 'atlas'>('webp');
  const [atlasRows, setAtlasRows] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [settingsCollapsed, setSettingsCollapsed] = useState(false);
  const [settingsPanelWidth, setSettingsPanelWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem('chroma-settings-panel-width'));
    return Number.isFinite(saved) && saved >= 280 && saved <= 760 ? Math.round(saved) : 380;
  });
  const [settingsResizing, setSettingsResizing] = useState(false);
  const [filesPanelWidth, setFilesPanelWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem('chroma-files-panel-width'));
    return Number.isFinite(saved) && saved >= 205 && saved <= 760 ? Math.round(saved) : Math.round(Math.min(550, Math.max(250, window.innerWidth * .28)));
  });
  const [filesResizing, setFilesResizing] = useState(false);
  const [previewSplit, setPreviewSplit] = useState(() => {
    const saved = Number(window.localStorage.getItem('chroma-preview-split'));
    return Number.isFinite(saved) && saved >= .2 && saved <= .8 ? saved : .5;
  });
  const [previewResizing, setPreviewResizing] = useState(false);
  const [previewGridWidth, setPreviewGridWidth] = useState(0);
  const [previewStageSize, setPreviewStageSize] = useState({ width: 0, height: 0 });
  const [previewActualSize, setPreviewActualSize] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  const previewGridRef = useRef<HTMLDivElement>(null);
  const outputStageRef = useRef<HTMLDivElement>(null);
  const settingsResizeRef = useRef<{ cleanup: () => void } | null>(null);
  const filesResizeRef = useRef<{ cleanup: () => void } | null>(null);
  const previewCueTimer = useRef<number | null>(null);
  const previewCueSequence = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const outputVideoRef = useRef<HTMLVideoElement>(null);
  const playbackVideoRef = useRef<HTMLVideoElement>(null);
  const outputRequestedFrame = useRef<number | null>(null);
  const outputCaptureSequence = useRef(0);
  const frameBlob = useRef<Blob | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const relinkInput = useRef<HTMLInputElement>(null);
  const relinkTargetId = useRef<string | null>(null);
  const loadedSourceFiles = useRef<WeakSet<File>>(new WeakSet());
  const loadingSourceIds = useRef<Set<string>>(new Set());
  const profileSaveTimers = useRef<Map<string, number>>(new Map());
  const profileSaveQueues = useRef<Map<string, Promise<unknown>>>(new Map());
  const lastProfileSerialized = useRef<Map<string, string>>(new Map());
  const pendingFrameSave = useRef<Promise<void>>(Promise.resolve());
  const pendingMaskSave = useRef<Promise<void>>(Promise.resolve());
  const backgroundInput = useRef<HTMLInputElement>(null);
  const previewSequence = useRef(0);
  const playbackSequence = useRef(0);
  const playbackAbort = useRef<AbortController | null>(null);
  const playbackJob = useRef('');
  const playbackObjectUrl = useRef('');
  const sourcePlayingRef = useRef(false);
  const timelineDrag = useRef<'start' | 'end' | 'frame' | null>(null);
  const cropDraftRef = useRef<{ x: number; y: number } | null>(null);
  const cropDrag = useRef<{ pointerX: number; pointerY: number; cropX: number; cropY: number; displayWidth: number; displayHeight: number } | null>(null);
  const foregroundDrag = useRef<{ pointerX: number; pointerY: number; x: number; y: number; width: number; height: number } | null>(null);
  const selectedFile = files[selected];
  const active = selectedFile && loadedSourceFiles.current.has(selectedFile) ? selectedFile : undefined;
  const activeProjectId = selectedFile ? projectIds.get(selectedFile) || null : null;
  const frameProject = rawFrameProject?.id === activeProjectId ? rawFrameProject : null;
  const frameProjectPreview = rawFrameProjectPreview?.projectId === activeProjectId ? rawFrameProjectPreview : null;
  const profile = selectedFile ? profiles.get(selectedFile) || newProfile(defaultDirectory) : idleProfile;
  const settings = profile.settings;
  const sourceFps = profile.sourceFps;
  const detectedFps = activeProjectId ? detectedSourceFps.get(activeProjectId) : undefined;
  const frame = profile.frame;
  const outputFrame = profile.outputFrame;
  const customWidthDraft = profile.widthDraft;
  const customHeightDraft = profile.heightDraft;
  const outputDirectory = profile.outputDirectory || defaultDirectory;
  const outputLabel = outputDirectory || 'Loading output folder…';
  const backgroundUrl = profile.backgroundUrl;
  const backgroundName = profile.backgroundName;
  const backgroundOriginalSize = profile.backgroundOriginalSize !== false;
  const activeRange = (selectedFile && ranges.get(selectedFile)) || { start: 1, end: null };
  const maxFrame = Math.max(1, Math.floor(duration * sourceFps));
  const effectiveStartFrame = Math.min(activeRange.start, maxFrame);
  const effectiveEndFrame = activeRange.end === null ? maxFrame : Math.max(effectiveStartFrame, Math.min(activeRange.end, maxFrame));
  const effectiveOutputFrame = Math.max(effectiveStartFrame, Math.min(effectiveEndFrame, outputFrame ?? frame));
  const previewSignature = JSON.stringify(['time-trim-v2', settings.color, settings.similarity, settings.blend, settings.fps, settings.size, settings.width, settings.height, settings.squareMode, settings.cropScale, settings.cropX, settings.cropY, effectiveStartFrame, effectiveEndFrame, sourceFps]);
  const hasCachedPreview = !!active && previewCache?.file === active && previewCache.signature === previewSignature;
  const receiveFramePreview = useCallback((preview: FramePreview | null) => {
    if (preview) editedPlayhead.current = preview.index;
    setFrameProjectPreview(preview);
  }, []);
  const receiveFrameProject = useCallback((project: Project | null) => setFrameProject(project), []);
  const receivePendingFrameSave = useCallback((pending: Promise<void>) => { pendingFrameSave.current = pending; }, []);
  const receivePendingMaskSave = useCallback((pending: Promise<void>) => { pendingMaskSave.current = pending; }, []);
  const switchPreviewOrder = useCallback((order: 'original' | 'edited') => {
    setOriginalPlaying(false);
    setEditedPlaying(false);
    setPreviewOrder(order);
    setPreviewCue({ order, key: ++previewCueSequence.current });
    if (previewCueTimer.current !== null) window.clearTimeout(previewCueTimer.current);
    previewCueTimer.current = window.setTimeout(() => { setPreviewCue(null); previewCueTimer.current = null; }, 2200);
  }, []);

  useEffect(() => {
    const stage = outputStageRef.current;
    const grid = previewGridRef.current;
    if (!stage) return;
    const measure = () => {
      const bounds = stage.getBoundingClientRect();
      const width = Math.round(bounds.width);
      const height = Math.round(bounds.height);
      setPreviewStageSize(current => current.width === width && current.height === height ? current : { width, height });
      if (grid) setPreviewGridWidth(Math.round(grid.getBoundingClientRect().width));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    if (grid) observer.observe(grid);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (previewCueTimer.current !== null) window.clearTimeout(previewCueTimer.current);
    previewCueTimer.current = null;
    setPreviewCue(null);
    setOriginalPreviewIndex(0);
    setOriginalPlaying(false);
    setEditedPlaying(false);
    setEditedPreviewSeek(null);
    editedPlayhead.current = 0;
    if (frameProject?.id) { setPreviewOrder('edited'); setExportOrder('edited'); }
    else { setPreviewOrder('original'); setExportOrder('original'); }
  }, [frameProject?.id]);
  useEffect(() => { setAdjustMode('position'); setOutputEditOpen(false); setForegroundMoveActive(false); }, [activeProjectId]);
  useEffect(() => {
    if (previewOrder === 'edited' && frameProjectPreview) setOriginalPreviewIndex(frameProjectPreview.index);
  }, [previewOrder, frameProjectPreview?.projectId, frameProjectPreview?.index]);
  useEffect(() => () => { if (previewCueTimer.current !== null) window.clearTimeout(previewCueTimer.current); }, []);

  useEffect(() => { window.localStorage.setItem('chroma-settings-panel-width', String(settingsPanelWidth)); }, [settingsPanelWidth]);
  useEffect(() => {
    if (!saveStatus || /^(Preparing|Generating|Exporting|Saving)/.test(saveStatus)) return;
    const timer = window.setTimeout(() => setSaveStatus(''), saveStatus.startsWith('Saved:') ? 5000 : 8000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);
  useEffect(() => { window.localStorage.setItem('chroma-files-panel-width', String(filesPanelWidth)); }, [filesPanelWidth]);
  useEffect(() => { window.localStorage.setItem('chroma-preview-split', String(previewSplit)); }, [previewSplit]);
  useEffect(() => {
    if (!originalPlaying || previewOrder !== 'original' || !frameProject || frameProject.frameCount < 1) return;
    const timer = window.setInterval(() => setOriginalPreviewIndex(index => (index + 1) % frameProject.frameCount), 1000 / frameProject.config.fps);
    return () => window.clearInterval(timer);
  }, [originalPlaying, previewOrder, frameProject?.id, frameProject?.frameCount, frameProject?.config.fps]);
  useEffect(() => {
    if (!editedPlaying || previewOrder !== 'edited' || !frameProject || frameProject.slots.length < 1) return;
    const timer = window.setInterval(() => {
      editedPlayhead.current = (editedPlayhead.current + 1) % frameProject.slots.length;
      setEditedPreviewSeek({ projectId: frameProject.id, index: editedPlayhead.current, token: ++editedSeekToken.current });
    }, 1000 / frameProject.config.fps);
    return () => window.clearInterval(timer);
  }, [editedPlaying, previewOrder, frameProject?.id, frameProject?.slots.length, frameProject?.config.fps]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(`${api}/projects`);
      if (!response.ok) throw await errorFrom(response);
      const summaries: ProjectSummary[] = (await response.json()).projects;
      if (!cancelled) setMissingSourceIds(new Set(summaries.filter(item => item.sourceMissing).map(item => item.id)));
      const loaded = await Promise.all(summaries.map(async item => {
        const [projectResponse, profileResponse] = await Promise.all([
          fetch(`${api}/projects/${item.id}`, { cache: 'no-store' }),
          fetch(`${api}/projects/${item.id}/profile`, { cache: 'no-store' }),
        ]);
        if (!projectResponse.ok) throw await errorFrom(projectResponse);
        if (!profileResponse.ok) throw await errorFrom(profileResponse);
        const project: Project = await projectResponse.json();
        const saved = (await profileResponse.json()).saved;
        const fallback = profileFromProject(project, '');
        let snapshot: { profile: FileProfile; range: FrameRange } | null = null;
        try { snapshot = JSON.parse(window.localStorage.getItem(savedProfileKey(item.id)) || 'null'); } catch { /* Ignore a damaged browser cache. */ }
        const record = snapshot || saved || fallback;
        const file = new File([], item.name, { type: 'video/mp4', lastModified: Date.parse(item.updatedAt) || Date.now() });
        const profile: FileProfile = { ...fallback.profile, ...record.profile, settings: { ...defaults, ...record.profile.settings } };
        if (profile.backgroundName) profile.backgroundUrl = `${api}/projects/${item.id}/background`;
        return { item, file, profile, range: record.range || fallback.range };
      }));
      if (cancelled) return;
      setProjectIds(new Map(loaded.map(({ item, file }) => [file, item.id])));
      setSourceSizes(new Map(loaded.map(({ item, file }) => [file, item.sourceBytes])));
      setProfiles(new Map(loaded.map(({ file, profile }) => [file, profile])));
      setRanges(new Map(loaded.map(({ file, range }) => [file, range])));
      setFiles(loaded.map(({ file }) => file));
      const remembered = window.localStorage.getItem('chroma-last-selected-file');
      const index = loaded.findIndex(({ item }) => item.id === remembered);
      setSelected(index >= 0 ? index : 0);
      setLibraryLoaded(true);
    })().catch(error => { if (!cancelled) { setPreviewStatus(error instanceof Error ? error.message : String(error)); setLibraryLoaded(true); } });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!selectedFile || !activeProjectId || missingSourceIds.has(activeProjectId) || loadedSourceFiles.current.has(selectedFile) || loadingSourceIds.current.has(activeProjectId)) return;
    const id = activeProjectId;
    const placeholder = selectedFile;
    loadingSourceIds.current.add(id);
    void fetch(`${api}/projects/${id}/source`).then(async response => {
      if (!response.ok) throw await errorFrom(response);
      const blob = await response.blob();
      const file = new File([blob], placeholder.name, { type: 'video/mp4', lastModified: placeholder.lastModified });
      loadedSourceFiles.current.add(file);
      setProjectIds(current => { const next = new Map(current); next.delete(placeholder); next.set(file, id); return next; });
      setSourceSizes(current => { const next = new Map(current); next.delete(placeholder); next.set(file, blob.size); return next; });
      setProfiles(current => { const next = new Map(current); const profile = next.get(placeholder); next.delete(placeholder); if (profile) next.set(file, profile); return next; });
      setRanges(current => { const next = new Map(current); const range = next.get(placeholder); next.delete(placeholder); if (range) next.set(file, range); return next; });
      setFiles(current => current.map(entry => entry === placeholder ? file : entry));
      setSourceErrors(current => { const next = { ...current }; delete next[id]; return next; });
    }).catch(error => setSourceErrors(current => ({ ...current, [id]: error instanceof Error ? error.message : String(error) }))).finally(() => loadingSourceIds.current.delete(id));
  }, [selectedFile, activeProjectId, missingSourceIds]);
  useEffect(() => {
    if (!active || !activeProjectId) return;
    const id = activeProjectId;
    let cancelled = false;
    void fetch(`${api}/projects/${id}/source-info`, { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw await errorFrom(response);
      return response.json();
    }).then(info => {
      if (!cancelled && Number.isFinite(info.fps) && info.fps > 0) setDetectedSourceFps(current => new Map(current).set(id, info.fps));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [active, activeProjectId, sourceRevision]);
  useEffect(() => {
    if (activeProjectId) window.localStorage.setItem('chroma-last-selected-file', activeProjectId);
  }, [activeProjectId]);
  useEffect(() => {
    if (!libraryLoaded) return;
    for (const file of files) {
      const id = projectIds.get(file);
      const profile = profiles.get(file);
      const range = ranges.get(file);
      if (!id || !profile || !range) continue;
      const saved = { profile: { ...profile, backgroundUrl: '' }, range };
      const serialized = JSON.stringify(saved);
      if (lastProfileSerialized.current.get(id) === serialized) continue;
      lastProfileSerialized.current.set(id, serialized);
      window.localStorage.setItem(savedProfileKey(id), serialized);
      const prior = profileSaveTimers.current.get(id);
      if (prior) window.clearTimeout(prior);
      profileSaveTimers.current.set(id, window.setTimeout(() => {
        const priorSave = profileSaveQueues.current.get(id) || Promise.resolve();
        const nextSave = priorSave.catch(() => {}).then(async () => {
          const response = await fetch(`${api}/projects/${id}/profile`, { method: 'PUT', headers: saveHeaders, body: serialized });
          if (!response.ok) throw await errorFrom(response);
        }).catch(error => { lastProfileSerialized.current.delete(id); setSourceErrors(current => ({ ...current, [id]: `Could not save settings: ${error.message}` })); });
        profileSaveQueues.current.set(id, nextSave);
      }, 300));
    }
  }, [files, profiles, ranges, projectIds, libraryLoaded]);
  useEffect(() => () => settingsResizeRef.current?.cleanup(), []);
  useEffect(() => () => filesResizeRef.current?.cleanup(), []);
  useEffect(() => {
    const clampWidth = () => {
      if (window.innerWidth > 1100) setSettingsPanelWidth(current => Math.min(current, maxSettingsPanelWidth()));
    };
    clampWidth();
    const observer = new ResizeObserver(clampWidth);
    if (layoutRef.current) observer.observe(layoutRef.current);
    return () => observer.disconnect();
  }, [filesCollapsed, filesPanelWidth]);

  useEffect(() => {
    const clampWidth = () => {
      if (window.innerWidth > 1100 && !filesCollapsed) setFilesPanelWidth(current => Math.min(current, maxFilesPanelWidth()));
    };
    clampWidth();
    const observer = new ResizeObserver(clampWidth);
    if (layoutRef.current) observer.observe(layoutRef.current);
    return () => observer.disconnect();
  }, [filesCollapsed, settingsPanelWidth]);

  function maxFilesPanelWidth() {
    const layoutWidth = layoutRef.current?.getBoundingClientRect().width || window.innerWidth;
    const settingsWidth = layoutRef.current?.querySelector('.chroma-settings-shell')?.getBoundingClientRect().width || (settingsCollapsed ? 54 : settingsPanelWidth);
    return Math.max(205, Math.min(760, Math.floor(layoutWidth - settingsWidth - 32 - 360)));
  }

  function onFilesResizeStart(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || filesCollapsed) return;
    event.preventDefault();
    filesResizeRef.current?.cleanup();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width || filesPanelWidth;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      setFilesPanelWidth(Math.round(Math.max(205, Math.min(maxFilesPanelWidth(), startWidth + next.clientX - startX))));
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      move(next);
      filesResizeRef.current?.cleanup();
      filesResizeRef.current = null;
      setFilesResizing(false);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    filesResizeRef.current = { cleanup };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    setFilesResizing(true);
  }

  function onFilesResizeKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const maxWidth = maxFilesPanelWidth();
    const step = event.shiftKey ? 48 : 16;
    setFilesPanelWidth(current => event.key === 'Home' ? 205 : event.key === 'End' ? maxWidth : Math.max(205, Math.min(maxWidth, current + (event.key === 'ArrowRight' ? step : -step))));
  }

  function maxSettingsPanelWidth() {
    const layoutWidth = layoutRef.current?.getBoundingClientRect().width || window.innerWidth;
    const roomForPreviews = layoutWidth - 32 - (filesCollapsed ? 54 : filesPanelWidth) - 360;
    return Math.max(280, Math.min(760, Math.floor(layoutWidth * .48), Math.floor(roomForPreviews)));
  }

  function onSettingsResizeStart(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || settingsCollapsed) return;
    event.preventDefault();
    settingsResizeRef.current?.cleanup();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width || settingsPanelWidth;
    const maxWidth = maxSettingsPanelWidth();
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      setSettingsPanelWidth(Math.round(Math.max(280, Math.min(maxWidth, startWidth + startX - next.clientX))));
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      move(next);
      settingsResizeRef.current?.cleanup();
      settingsResizeRef.current = null;
      setSettingsResizing(false);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    settingsResizeRef.current = { cleanup };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    setSettingsResizing(true);
  }

  function onSettingsResizeKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 48 : 16;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const maxWidth = maxSettingsPanelWidth();
    setSettingsPanelWidth(current => event.key === 'Home' ? 280 : event.key === 'End' ? maxWidth : Math.max(280, Math.min(maxWidth, current + (event.key === 'ArrowLeft' ? step : -step))));
  }

  function previewSplitBounds() {
    const available = (previewGridWidth || previewGridRef.current?.getBoundingClientRect().width || 500) - 12;
    const minimum = Math.min(.5, 180 / Math.max(1, available));
    return { minimum, maximum: 1 - minimum };
  }

  function updatePreviewSplit(clientX: number) {
    const bounds = previewGridRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const { minimum, maximum } = previewSplitBounds();
    const available = bounds.width - 12;
    setPreviewSplit(Math.max(minimum, Math.min(maximum, (clientX - bounds.left - 6) / available)));
  }

  function onPreviewResizeKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const { minimum, maximum } = previewSplitBounds();
    const step = event.shiftKey ? .05 : .02;
    setPreviewSplit(current => event.key === 'Home' ? minimum : event.key === 'End' ? maximum : Math.max(minimum, Math.min(maximum, current + (event.key === 'ArrowRight' ? step : -step))));
  }

  function updateProfile(update: (current: FileProfile) => FileProfile) {
    if (selectedFile) setProfiles(current => { const next = new Map<File, FileProfile>(current); next.set(selectedFile, update(next.get(selectedFile) || newProfile(defaultDirectory))); return next; });
    else setIdleProfile(update);
  }

  function setSettings(value: React.SetStateAction<Settings>) {
    updateProfile(current => ({ ...current, settings: typeof value === 'function' ? value(current.settings) : value }));
  }

  function setSourceFps(value: number) { updateProfile(current => ({ ...current, sourceFps: value })); }
  function setFrame(value: React.SetStateAction<number>) { updateProfile(current => ({ ...current, frame: typeof value === 'function' ? value(current.frame) : value })); }
  function setOutputFrame(value: number | null) { updateProfile(current => ({ ...current, outputFrame: value })); }
  function setCustomWidthDraft(value: string) { updateProfile(current => ({ ...current, widthDraft: value })); }
  function setCustomHeightDraft(value: string) { updateProfile(current => ({ ...current, heightDraft: value })); }
  function setOutputDirectory(value: string) { updateProfile(current => ({ ...current, outputDirectory: value })); }

  useEffect(() => {
    fetch(`${api}/output-directory`).then(response => response.json()).then(async data => {
      setDefaultDirectory(data.path);
      const stored = window.localStorage.getItem('chroma-output-directory');
      let chosen = data.path;
      if (stored && stored !== data.path) {
        const checked = await fetch(`${api}/output-directory`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chroma-Save': '1' }, body: JSON.stringify({ path: stored }) });
        if (checked.ok) chosen = (await checked.json()).path;
        else window.localStorage.removeItem('chroma-output-directory');
      }
      setIdleProfile(current => ({ ...current, outputDirectory: chosen }));
      setProfiles(current => new Map(Array.from(current, ([file, profile]) => [file, profile.outputDirectory ? profile : { ...profile, outputDirectory: chosen }])));
      setDirectoryDraft(chosen);
    }).catch(() => setFolderError('Could not read the default output folder.'));
  }, []);

  useEffect(() => {
    sourcePlayingRef.current = false;
    videoRef.current?.pause();
    setSourcePlaying(false);
    setCropEditing(false);
    setCropDragging(false);
    setOutputEditOpen(false);
    setForegroundDragging(false);
    setForegroundMoveActive(false);
    foregroundDrag.current = null;
    setCropDraft(null);
    cropDraftRef.current = null;
    cropDrag.current = null;
    setDirectoryOpen(false);
    setDirectoryDraft(selectedFile ? profiles.get(selectedFile)?.outputDirectory || defaultDirectory : idleProfile.outputDirectory || defaultDirectory);
    if (!active) { setSourceUrl(''); setDuration(0); setVideoSize({ width: 0, height: 0 }); setFrameUrl(''); setPreviewUrl(''); setPreviewStatus(selectedFile ? 'Loading saved MP4…' : 'Select an MP4 to preview'); return; }
    const url = URL.createObjectURL(active);
    setSourceUrl(url);
    setDuration(0);
    setVideoSize({ width: 0, height: 0 });
    setFrameUrl('');
    setPreviewUrl('');
    setOutputFrameCapture(null);
    outputRequestedFrame.current = null;
    outputCaptureSequence.current++;
    frameBlob.current = null;
    setPreviewStatus('Reading video…');
    return () => URL.revokeObjectURL(url);
  }, [active, selectedFile]);

  useEffect(() => {
    if (settings.size === 'original' || settings.squareMode !== 'crop') {
      setCropEditing(false);
      setCropDragging(false);
      setCropDraft(null);
      cropDraftRef.current = null;
      cropDrag.current = null;
    }
  }, [settings.size, settings.squareMode]);

  useEffect(() => {
    if (!sourceUrl || !duration || !videoRef.current) return;
    if (sourcePlayingRef.current) return;
    const video = videoRef.current;
    const target = Math.min(Math.max(0, (frame - 1) / sourceFps), Math.max(0, duration - 0.001));
    if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) captureFrame();
    else video.currentTime = target;
  }, [sourceUrl, duration, frame, sourceFps]);

  function captureFrame() {
    if (sourcePlayingRef.current) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      if (!blob) return;
      frameBlob.current = blob;
      setFrameUrl(old => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
    }, 'image/png');
  }

  function captureOutputFrame() {
    const requested = outputRequestedFrame.current;
    const sequence = outputCaptureSequence.current;
    const video = outputVideoRef.current;
    if (requested === null || !video?.videoWidth || !video.videoHeight) return;
    const target = Math.min((requested - 1) / sourceFps, Math.max(0, duration - 0.001));
    if (Math.abs(video.currentTime - target) > 0.02) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      if (blob && outputRequestedFrame.current === requested && outputCaptureSequence.current === sequence) setOutputFrameCapture({ frame: requested, blob });
    }, 'image/png');
  }

  function seekOutputVideo() {
    if (!sourceUrl || !duration || outputFrame === null || hasCachedPreview) return;
    const video = outputVideoRef.current;
    if (!video || video.readyState < 1) return;
    outputRequestedFrame.current = effectiveOutputFrame;
    const target = Math.min((effectiveOutputFrame - 1) / sourceFps, Math.max(0, duration - 0.001));
    if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) captureOutputFrame();
    else video.currentTime = target;
  }

  useEffect(() => { seekOutputVideo(); }, [sourceUrl, duration, outputFrame, effectiveOutputFrame, sourceFps, hasCachedPreview]);

  useEffect(() => {
    if (hasCachedPreview) return;
    const sourceBlob = outputFrame === null ? frameBlob.current : outputFrameCapture?.frame === effectiveOutputFrame ? outputFrameCapture.blob : null;
    if (!sourceBlob || (outputFrame === null && !frameUrl)) return;
    const seq = ++previewSequence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreviewStatus('Updating key preview…');
      try {
        const config = { ...settings, foregroundZoom: 1, foregroundX: 0, foregroundY: 0 };
        const response = await fetch(`${api}/preview?config=${encodeURIComponent(JSON.stringify(config))}`, {
          method: 'POST', body: sourceBlob, signal: controller.signal,
        });
        if (!response.ok) throw await errorFrom(response);
        const blob = await response.blob();
        if (seq !== previewSequence.current) return;
        setPreviewUrl(old => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
        setPreviewStatus('Preview updated');
      } catch (error) {
        if (controller.signal.aborted) return;
        setPreviewStatus(error instanceof Error ? error.message : String(error));
      }
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [frameUrl, outputFrame, outputFrameCapture, effectiveOutputFrame, hasCachedPreview, settings.color, settings.similarity, settings.blend, settings.fps, settings.size, settings.width, settings.height, settings.squareMode, settings.cropScale, settings.cropX, settings.cropY]);


  function stopPlayback(clearCache = false) {
    playbackSequence.current++;
    playbackAbort.current?.abort();
    playbackAbort.current = null;
    if (playbackJob.current) {
      void fetch(`${api}/jobs/${playbackJob.current}`, { method: 'DELETE' }).catch(() => {});
      playbackJob.current = '';
    }
    playbackVideoRef.current?.pause();
    setAnimationPlaying(false);
    if (clearCache) {
      if (playbackObjectUrl.current) URL.revokeObjectURL(playbackObjectUrl.current);
      playbackObjectUrl.current = '';
      setPreviewCache(null);
    }
    setPreviewRendering(false);
    setPlaybackStatus('');
    setPlaybackProgress(0);
  }

  useEffect(() => { stopPlayback(true); }, [active, previewSignature]);
  useEffect(() => {
    const video = playbackVideoRef.current;
    if (!hasCachedPreview || !video) return;
    if (animationPlaying) void video.play().catch(() => { setAnimationPlaying(false); setPlaybackStatus('This browser cannot play the transparent interval preview.'); });
    else video.pause();
  }, [hasCachedPreview, previewCache, animationPlaying]);
  useEffect(() => {
    const video = playbackVideoRef.current;
    if (!hasCachedPreview || !video || animationPlaying) return;
    const target = Math.max(0, (effectiveOutputFrame - effectiveStartFrame) / sourceFps);
    if (Math.abs(video.currentTime - target) > 0.01) video.currentTime = target;
  }, [hasCachedPreview, previewCache, animationPlaying, effectiveOutputFrame, effectiveStartFrame, sourceFps]);
  useEffect(() => () => {
    playbackAbort.current?.abort();
    if (playbackJob.current) void fetch(`${api}/jobs/${playbackJob.current}`, { method: 'DELETE' }).catch(() => {});
    if (playbackObjectUrl.current) URL.revokeObjectURL(playbackObjectUrl.current);
  }, []);

  async function playSelectedRange() {
    if (!active || previewRendering || !customSizeValid) return;
    if (hasCachedPreview) {
      setAnimationPlaying(true);
      setPlaybackStatus(`Cached · looping frames ${effectiveStartFrame}–${effectiveEndFrame}`);
      return;
    }
    stopPlayback();
    const sequence = playbackSequence.current;
    const controller = new AbortController();
    playbackAbort.current = controller;
    setPreviewRendering(true);
    setPlaybackStatus('Generating interval preview…');
    let jobId = '';
    try {
      const config = { ...settings, foregroundZoom: 1, foregroundX: 0, foregroundY: 0, startFrame: effectiveStartFrame, endFrame: effectiveEndForConfig, sourceFps };
      const create = await fetch(`${api}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: active.name, config, preview: true }), signal: controller.signal });
      if (!create.ok) throw await errorFrom(create);
      const job = await create.json();
      jobId = job.id;
      if (sequence !== playbackSequence.current) return;
      playbackJob.current = jobId;
      setPlaybackStatus('Reading local video…');
      const upload = await fetch(`${api}/jobs/${jobId}/source`, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: active, signal: controller.signal });
      if (!upload.ok) throw await errorFrom(upload);
      while (true) {
        if (sequence !== playbackSequence.current) return;
        const response = await fetch(`${api}/jobs/${jobId}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw await errorFrom(response);
        const state = await response.json();
        if (state.status === 'error') throw new Error(state.error || 'Could not generate the preview.');
        setPlaybackProgress(state.progress || 0);
        setPlaybackStatus(state.status === 'done' ? 'Loading animation…' : `Generating interval preview · ${Math.round(state.progress || 0)}%`);
        if (state.status === 'done') break;
        await sleep(300);
      }
      const response = await fetch(`${api}/jobs/${jobId}/output`, { signal: controller.signal });
      if (!response.ok) throw await errorFrom(response);
      const blob = await response.blob();
      if (sequence !== playbackSequence.current) return;
      const url = URL.createObjectURL(blob);
      playbackObjectUrl.current = url;
      setPreviewCache({ file: active, signature: previewSignature, url });
      setAnimationPlaying(true);
      setPlaybackStatus(`Cached · looping frames ${effectiveStartFrame}–${effectiveEndFrame}`);
    } catch (error) {
      if (sequence === playbackSequence.current && !controller.signal.aborted) setPlaybackStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (jobId) await fetch(`${api}/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
      if (playbackJob.current === jobId) playbackJob.current = '';
      if (sequence === playbackSequence.current) { setPreviewRendering(false); playbackAbort.current = null; }
    }
  }

  function setRangeStart(value: number) {
    if (!selectedFile) return;
    const start = Math.max(1, Math.min(effectiveEndFrame, Math.round(value) || 1));
    setRanges(current => {
      const old = current.get(selectedFile) || { start: 1, end: null };
      const next = new Map(current);
      next.set(selectedFile, { start, end: old.end });
      return next;
    });
  }

  function setRangeEnd(value: number) {
    if (!selectedFile) return;
    const end = Math.max(activeRange.start, Math.min(maxFrame, Math.round(value) || activeRange.start));
    setRanges(current => {
      const next = new Map(current);
      next.set(selectedFile, { start: current.get(selectedFile)?.start || 1, end });
      return next;
    });
  }

  function seekSourceFrame(value: number) {
    const next = Math.max(1, Math.min(maxFrame, Math.round(value)));
    setFrame(next);
    if (sourcePlayingRef.current && videoRef.current) videoRef.current.currentTime = Math.min((next - 1) / sourceFps, Math.max(0, duration - 0.001));
  }

  function jumpToRangeFrame(value: number) {
    if (!active || !duration) return;
    if (sourcePlayingRef.current) {
      sourcePlayingRef.current = false;
      videoRef.current?.pause();
      setSourcePlaying(false);
    }
    stopPlayback();
    seekSourceFrame(value);
  }

  function previewOutputFrame(value: number) {
    if (!active || !duration) return;
    stopPlayback();
    if (!hasCachedPreview) setPreviewStatus('Reading output frame…');
    setOutputFrame(Math.max(effectiveStartFrame, Math.min(effectiveEndFrame, Math.round(value))));
  }

  function updateTimeline(kind: 'start' | 'end' | 'frame', value: number) {
    const next = Math.max(1, Math.min(maxFrame, Math.round(value)));
    if (kind === 'start') setRangeStart(next);
    if (kind === 'end') setRangeEnd(next);
    seekSourceFrame(next);
  }

  function frameAtPointer(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    return 1 + fraction * (maxFrame - 1);
  }

  function onTimelinePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!active || !duration) return;
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset.handle;
    timelineDrag.current = handle === 'start' || handle === 'end' ? handle : 'frame';
    event.currentTarget.setPointerCapture(event.pointerId);
    updateTimeline(timelineDrag.current, frameAtPointer(event));
  }

  function onTimelinePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (timelineDrag.current) updateTimeline(timelineDrag.current, frameAtPointer(event));
  }

  function onTimelinePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    timelineDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onTimelineHandleKey(event: React.KeyboardEvent<HTMLElement>, kind: 'start' | 'end') {
    let next: number;
    if (event.key === 'ArrowLeft') next = (kind === 'start' ? effectiveStartFrame : effectiveEndFrame) - (event.shiftKey ? 10 : 1);
    else if (event.key === 'ArrowRight') next = (kind === 'start' ? effectiveStartFrame : effectiveEndFrame) + (event.shiftKey ? 10 : 1);
    else if (event.key === 'Home') next = kind === 'start' ? 1 : effectiveStartFrame;
    else if (event.key === 'End') next = kind === 'start' ? effectiveEndFrame : maxFrame;
    else return;
    event.preventDefault();
    updateTimeline(kind, next);
  }

  function stopSourcePlayback() {
    sourcePlayingRef.current = false;
    videoRef.current?.pause();
    setSourcePlaying(false);
    captureFrame();
  }

  function applyFitMode(mode: 'original' | Settings['squareMode']) {
    if (mode === 'original') { setSettings(current => ({ ...current, size: 'original' })); return; }
    if (settings.size === 'original') {
      const side = Math.max(16, Math.min(4096, videoSize.width || 512, videoSize.height || 512));
      setCustomWidthDraft(String(side));
      setCustomHeightDraft(String(side));
      setSettings(current => ({ ...current, size: 'custom', width: side, height: side, squareMode: mode }));
    } else setSettings(current => ({ ...current, squareMode: mode }));
  }

  function startCropEditor() {
    if (!active) return;
    if (settings.size === 'original') { applyFitMode('crop'); setCropEditing(true); }
    else toggleCropEditor();
  }

  function toggleCropEditor() {
    if (!active || !cropWidth || settings.size === 'original' || settings.squareMode !== 'crop') return;
    if (cropEditing) {
      setCropEditing(false);
      setCropDragging(false);
      cropDrag.current = null;
      setCropDraft(null);
      cropDraftRef.current = null;
    } else {
      if (sourcePlayingRef.current) stopSourcePlayback();
      setCropEditing(true);
    }
  }

  function updateCropDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = cropDrag.current;
    if (!drag) return;
    const availableX = videoSize.width - cropWidth;
    const availableY = videoSize.height - cropHeight;
    const sourceDeltaX = (event.clientX - drag.pointerX) / drag.displayWidth * videoSize.width;
    const sourceDeltaY = (event.clientY - drag.pointerY) / drag.displayHeight * videoSize.height;
    const x = availableX > 0 ? Math.max(0, Math.min(1, (drag.cropX * availableX - sourceDeltaX) / availableX)) : 0.5;
    const y = availableY > 0 ? Math.max(0, Math.min(1, (drag.cropY * availableY - sourceDeltaY) / availableY)) : 0.5;
    const next = { x, y };
    cropDraftRef.current = next;
    setCropDraft(next);
  }

  function onCropPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!cropEditing || !cropWidth || !(event.target as HTMLElement).closest('.chroma-edit-crop-frame')) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    cropDrag.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      cropX: cropDraft?.x ?? settings.cropX,
      cropY: cropDraft?.y ?? settings.cropY,
      displayWidth: bounds.width * editImageWidthPercent / 100,
      displayHeight: bounds.height * editImageHeightPercent / 100,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setCropDragging(true);
  }

  function onCropPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (cropDrag.current) updateCropDrag(event);
  }

  function onCropPointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (!cropDrag.current) return;
    updateCropDrag(event);
    const chosen = cropDraftRef.current;
    if (chosen) setSettings(current => ({ ...current, cropX: chosen.x, cropY: chosen.y }));
    cropDrag.current = null;
    cropDraftRef.current = null;
    setCropDraft(null);
    setCropDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onForegroundPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !outputEditOpen || adjustMode !== 'position' || !foregroundMoveActive || (!active && !frameProjectPreview)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    foregroundDrag.current = { pointerX: event.clientX, pointerY: event.clientY, x: settings.foregroundX, y: settings.foregroundY, width: bounds.width, height: bounds.height };
    event.currentTarget.setPointerCapture(event.pointerId);
    setForegroundDragging(true);
  }

  function onForegroundPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = foregroundDrag.current;
    if (!drag) return;
    setSettings(current => ({ ...current, foregroundX: Math.max(-1, Math.min(1, drag.x + (event.clientX - drag.pointerX) / drag.width)), foregroundY: Math.max(-1, Math.min(1, drag.y + (event.clientY - drag.pointerY) / drag.height)) }));
  }

  function onForegroundPointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (!foregroundDrag.current) return;
    onForegroundPointerMove(event);
    foregroundDrag.current = null;
    setForegroundDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function toggleSourcePlayback() {
    const video = videoRef.current;
    if (!video || !duration) return;
    if (sourcePlayingRef.current) { stopSourcePlayback(); return; }
    sourcePlayingRef.current = true;
    setSourcePlaying(true);
    video.currentTime = (effectiveStartFrame - 1) / sourceFps;
    try { await video.play(); }
    catch (error) {
      sourcePlayingRef.current = false;
      setSourcePlaying(false);
      setPreviewStatus(error instanceof Error ? error.message : 'Could not play the source video.');
    }
  }

  function onSourceTimeUpdate() {
    const video = videoRef.current;
    if (!sourcePlayingRef.current || !video) return;
    const lastTime = Math.min(duration, effectiveEndFrame / sourceFps);
    if (video.currentTime >= lastTime - 0.001) {
      video.currentTime = (effectiveStartFrame - 1) / sourceFps;
      if (video.paused) void video.play().catch(() => stopSourcePlayback());
      return;
    }
    setFrame(Math.max(effectiveStartFrame, Math.min(effectiveEndFrame, Math.floor(video.currentTime * sourceFps) + 1)));
  }

  function updateCustomDimension(axis: 'width' | 'height', value: string) {
    if (axis === 'width') setCustomWidthDraft(value); else setCustomHeightDraft(value);
    const number = Number(value);
    if (/^\d+$/.test(value) && number >= 16 && number <= 4096) setSettings(current => ({ ...current, [axis]: number }));
  }

  function normalizeCustomDimension(axis: 'width' | 'height') {
    const draft = axis === 'width' ? customWidthDraft : customHeightDraft;
    const number = Math.max(16, Math.min(4096, Math.round(Number(draft) || 512)));
    if (axis === 'width') setCustomWidthDraft(String(number)); else setCustomHeightDraft(String(number));
    setSettings(current => ({ ...current, [axis]: number }));
  }

  async function addFiles(list: FileList | File[]) {
    if (running) return;
    const mp4s = Array.from(list).filter(file => /\.mp4$/i.test(file.name));
    if (!mp4s.length) { setPreviewStatus('Select an MP4 file.'); return; }
    setRunning(true);
    for (const [uploadIndex, file] of mp4s.entries()) {
      let createdId = '';
      try {
        setPreviewStatus(`Saving ${file.name} locally…`);
        const initial = files.length === 0 && uploadIndex === 0 ? { ...idleProfile, settings: { ...idleProfile.settings } } : newProfile(idleProfile.outputDirectory || defaultDirectory);
        const range: FrameRange = { start: 1, end: null };
        const create = await fetch(`${api}/projects`, { method: 'POST', headers: saveHeaders, body: JSON.stringify({ name: file.name, config: { ...initial.settings, sourceFps: initial.sourceFps, startFrame: 1, endFrame: null }, outputDirectory: initial.outputDirectory || defaultDirectory, deferGeneration: true }) });
        if (!create.ok) throw await errorFrom(create);
        createdId = (await create.json()).id;
        const upload = await fetch(`${api}/projects/${createdId}/source`, { method: 'PUT', headers: { 'X-Chroma-Save': '1', 'Content-Type': 'video/mp4' }, body: file });
        if (!upload.ok) throw await errorFrom(upload);
        const sourceInfo = await fetch(`${api}/projects/${createdId}/source-info`);
        if (!sourceInfo.ok) throw await errorFrom(sourceInfo);
        const info = await sourceInfo.json();
        if (Number.isFinite(info.fps) && info.fps > 0) {
          initial.sourceFps = Number(info.fps.toFixed(3));
          setDetectedSourceFps(current => new Map(current).set(createdId, info.fps));
        }
        const profileSave = await fetch(`${api}/projects/${createdId}/profile`, { method: 'PUT', headers: saveHeaders, body: JSON.stringify({ profile: { ...initial, backgroundUrl: '' }, range }) });
        if (!profileSave.ok) throw await errorFrom(profileSave);
        loadedSourceFiles.current.add(file);
        setProjectIds(current => new Map(current).set(file, createdId));
        setSourceSizes(current => new Map(current).set(file, file.size));
        setProfiles(current => new Map(current).set(file, initial));
        setRanges(current => new Map(current).set(file, range));
        setFiles(current => [...current, file]);
        setPreviewStatus(`${file.name} saved locally`);
      } catch (error) {
        if (createdId) await fetch(`${api}/projects/${createdId}?permanent=1`, { method: 'DELETE', headers: { 'X-Chroma-Save': '1' } }).catch(() => {});
        setPreviewStatus(error instanceof Error ? error.message : String(error));
      }
    }
    setRunning(false);
  }

  async function replaceCurrentSource(file: File) {
    const previous = selectedFile;
    const id = activeProjectId;
    if (!previous || !active || !id || running) return;
    if (!/\.mp4$/i.test(file.name)) { setPreviewStatus('Select an MP4 file.'); return; }
    if (!window.confirm(`Replace ${previous.name} with ${file.name}? Its generated PNG frames, frame edits, and output mask will be removed.`)) return;
    setRunning(true);
    setPreviewStatus(`Checking ${file.name}…`);
    try {
      await pendingFrameSave.current;
      await pendingMaskSave.current;
      const response = await fetch(`${api}/projects/${id}/source?replace=1&name=${encodeURIComponent(file.name)}`, { method: 'PUT', headers: { 'X-Chroma-Save': '1', 'Content-Type': 'video/mp4' }, body: file });
      if (!response.ok) throw await errorFrom(response);
      const info = await fetch(`${api}/projects/${id}/source-info`).then(response => response.ok ? response.json() : null).catch(() => null);
      const replacementFps = info && Number.isFinite(info.fps) && info.fps > 0 ? Number(info.fps.toFixed(3)) : null;
      stopPlayback(true);
      dismissRecentOutput();
      loadedSourceFiles.current.add(file);
      setProjectIds(current => { const next = new Map(current); next.delete(previous); next.set(file, id); return next; });
      setSourceSizes(current => { const next = new Map(current); next.delete(previous); next.set(file, file.size); return next; });
      setProfiles(current => {
        const next = new Map<File, FileProfile>(current);
        const saved = next.get(previous) || newProfile(defaultDirectory);
        next.delete(previous);
        next.set(file, { ...saved, sourceFps: replacementFps ?? saved.sourceFps, frame: 1, outputFrame: null });
        return next;
      });
      setRanges(current => { const next = new Map(current); next.delete(previous); next.set(file, { start: 1, end: null }); return next; });
      setFiles(current => current.map(entry => entry === previous ? file : entry));
      setFrameProject(null);
      setFrameProjectPreview(null);
      setSourceRevision(current => current + 1);
      setDetectedSourceFps(current => { const next = new Map(current); if (replacementFps) next.set(id, replacementFps); else next.delete(id); return next; });
      setSourceErrors(current => { const next = { ...current }; delete next[id]; return next; });
      setPreviewStatus(`${file.name} replaced the current source`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPreviewStatus(message);
      setSourceErrors(current => ({ ...current, [id]: message }));
    } finally {
      setRunning(false);
    }
  }

  async function relinkMissingSource(id: string, candidate: File) {
    const previous = files.find(file => projectIds.get(file) === id);
    if (!previous || running) return;
    if (!/\.mp4$/i.test(candidate.name)) { setSourceErrors(current => ({ ...current, [id]: 'Select an MP4 file.' })); return; }
    setRunning(true);
    setSourceErrors(current => ({ ...current, [id]: `Checking ${candidate.name} against the saved file…` }));
    try {
      const response = await fetch(`${api}/projects/${id}/relink-source`, { method: 'PUT', headers: { 'X-Chroma-Save': '1', 'Content-Type': 'video/mp4' }, body: candidate });
      if (!response.ok) throw await errorFrom(response);
      const restored = new File([candidate], previous.name, { type: 'video/mp4', lastModified: previous.lastModified });
      loadedSourceFiles.current.add(restored);
      setProjectIds(current => { const next = new Map(current); next.delete(previous); next.set(restored, id); return next; });
      setSourceSizes(current => { const next = new Map(current); next.delete(previous); next.set(restored, candidate.size); return next; });
      setProfiles(current => { const next = new Map(current); const saved = next.get(previous); next.delete(previous); if (saved) next.set(restored, saved); return next; });
      setRanges(current => { const next = new Map(current); const saved = next.get(previous); next.delete(previous); if (saved) next.set(restored, saved); return next; });
      setFiles(current => current.map(file => file === previous ? restored : file));
      setMissingSourceIds(current => { const next = new Set(current); next.delete(id); return next; });
      setSourceErrors(current => { const next = { ...current }; delete next[id]; return next; });
      if (activeProjectId === id) setSourceRevision(current => current + 1);
      setPreviewStatus(`${previous.name} restored from ${candidate.name}; frame edits and settings are unchanged.`);
    } catch (error) {
      setSourceErrors(current => ({ ...current, [id]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setRunning(false);
    }
  }

  async function updateBackground(file: File) {
    if (!activeProjectId || !file.type.startsWith('image/')) return;
    try {
      const response = await fetch(`${api}/projects/${activeProjectId}/background?name=${encodeURIComponent(file.name)}`, { method: 'PUT', headers: { 'X-Chroma-Save': '1', 'Content-Type': file.type }, body: file });
      if (!response.ok) throw await errorFrom(response);
      updateProfile(current => ({ ...current, backgroundUrl: `${api}/projects/${activeProjectId}/background?v=${Date.now()}`, backgroundName: file.name }));
    } catch (error) { setPreviewStatus(error instanceof Error ? error.message : String(error)); }
  }

  async function clearBackground() {
    if (!activeProjectId) return;
    const response = await fetch(`${api}/projects/${activeProjectId}/background`, { method: 'DELETE', headers: { 'X-Chroma-Save': '1' } });
    if (!response.ok) { setPreviewStatus((await errorFrom(response)).message); return; }
    updateProfile(current => ({ ...current, backgroundUrl: '', backgroundName: '' }));
  }

  async function removeFile(index: number) {
    if (running) return;
    const file = files[index];
    const id = projectIds.get(file);
    if (!id || !window.confirm(`Remove ${file.name} and its saved frame edits from this computer?`)) return;
    const response = await fetch(`${api}/projects/${id}?permanent=1`, { method: 'DELETE', headers: { 'X-Chroma-Save': '1' } });
    if (!response.ok) { setPreviewStatus((await errorFrom(response)).message); return; }
    window.localStorage.removeItem(savedProfileKey(id));
    const pendingTimer = profileSaveTimers.current.get(id);
    if (pendingTimer) window.clearTimeout(pendingTimer);
    profileSaveTimers.current.delete(id);
    profileSaveQueues.current.delete(id);
    lastProfileSerialized.current.delete(id);
    setFiles(current => current.filter((_, item) => item !== index));
    setProjectIds(current => { const next = new Map(current); next.delete(file); return next; });
    setSourceSizes(current => { const next = new Map(current); next.delete(file); return next; });
    setDetectedSourceFps(current => { const next = new Map(current); next.delete(id); return next; });
    setProfiles(current => { const next = new Map(current); next.delete(file); return next; });
    setRanges(current => { const next = new Map(current); next.delete(file); return next; });
    setSelected(current => current > index ? current - 1 : current === index ? 0 : current);
  }

  function chooseFolder() {
    if (running) return;
    setDirectoryOpen(current => !current);
    setDirectoryError('');
  }

  async function pickFolderNative() {
    setDirectoryError('');
    setDirectoryPicking(true);
    try {
      const response = await fetch(`${api}/pick-directory`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chroma-Save': '1' }, body: JSON.stringify({ path: directoryDraft }) });
      if (!response.ok) throw await errorFrom(response);
      const data = await response.json();
      if (data.path) selectOutputDirectory(data.path);
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : String(error));
    } finally { setDirectoryPicking(false); }
  }

  function selectOutputDirectory(directory: string) {
    setOutputDirectory(directory);
    window.localStorage.setItem('chroma-output-directory', directory);
    setDirectoryDraft(directory);
    setDirectoryOpen(false);
    setFolderError('');
  }

  async function openSelectedFolder() {
    if (!outputDirectory) return;
    setFolderError('');
    try {
      const response = await fetch(`${api}/open-directory`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chroma-Save': '1' }, body: JSON.stringify({ path: outputDirectory }) });
      if (!response.ok) throw await errorFrom(response);
    } catch (error) { setFolderError(error instanceof Error ? error.message : String(error)); }
  }

  async function applyDirectory() {
    setDirectoryError('');
    try {
      const response = await fetch(`${api}/output-directory`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chroma-Save': '1' }, body: JSON.stringify({ path: directoryDraft.trim().replace(/^"|"$/g, '') }) });
      if (!response.ok) throw await errorFrom(response);
      const data = await response.json();
      selectOutputDirectory(data.path);
    } catch (error) { setDirectoryError(error instanceof Error ? error.message : String(error)); }
  }

  async function saveResult(blob: Blob, name: string): Promise<{ path: string; name: string }> {
    const query = new URLSearchParams({ name, directory: outputDirectory });
    const response = await fetch(`${api}/save?${query}`, { method: 'POST', headers: { 'Content-Type': 'image/webp', 'X-Chroma-Save': '1' }, body: blob });
    if (!response.ok) throw await errorFrom(response);
    return response.json();
  }

  async function openOutputFolder() {
    if (!recentOutput) return;
    if (!recentOutput.savedPath) {
      setSaveStatus('Saving…');
      try {
        const saved = await saveResult(recentOutput.blob, recentOutput.name);
        setRecentOutput(current => current ? { ...current, savedPath: saved.path } : current);
        setSaveStatus(`Saved: ${saved.path}`);
      } catch (error) { setSaveStatus(error instanceof Error ? error.message : String(error)); }
      return;
    }
    try {
      const response = await fetch(`${api}/reveal`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chroma-Save': '1' }, body: JSON.stringify({ path: recentOutput.savedPath }) });
      if (!response.ok) throw await errorFrom(response);
      setSaveStatus(`Saved: ${recentOutput.savedPath}`);
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function dismissRecentOutput() {
    if (recentOutput) URL.revokeObjectURL(recentOutput.url);
    setRecentOutput(null);
    setSaveStatus('');
  }

  async function convertOne(file: File, index: number) {
    const key = fileKey(file, index);
    let jobId = '';
    const update = (state: FileState) => setStates(current => ({ ...current, [key]: state }));
    try {
      update({ status: 'Preparing', progress: 0 });
      const range = ranges.get(file) || { start: 1, end: null };
      const config = { ...settings, startFrame: index === selected ? Math.min(range.start, maxFrame) : range.start, endFrame: index === selected && range.end !== null ? Math.min(range.end, maxFrame) : range.end, sourceFps };
      const create = await fetch(`${api}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, config }) });
      if (!create.ok) throw await errorFrom(create);
      const job = await create.json();
      jobId = job.id;
      update({ status: 'Sending to local process', progress: 0 });
      const upload = await fetch(`${api}/jobs/${jobId}/source`, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: file });
      if (!upload.ok) throw await errorFrom(upload);
      while (true) {
        const response = await fetch(`${api}/jobs/${jobId}`, { cache: 'no-store' });
        if (!response.ok) throw await errorFrom(response);
        const state = await response.json();
        if (state.status === 'error') throw new Error(state.error || 'FFmpeg conversion failed.');
        update({ status: state.status === 'done' ? 'Saving output' : state.status === 'probing' ? 'Reading video metadata' : 'Converting with FFmpeg', progress: state.progress });
        if (state.status === 'done') break;
        await sleep(300);
      }
      const response = await fetch(`${api}/jobs/${jobId}/output`);
      if (!response.ok) throw await errorFrom(response);
      const blob = await response.blob();
      const name: string = job.name;
      if (index === selected) {
        setSaveStatus('Saving…');
        setRecentOutput(old => { if (old) URL.revokeObjectURL(old.url); return { blob, url: URL.createObjectURL(blob), name, savedPath: '' }; });
      }
      const saved = await saveResult(blob, name);
      if (index === selected) {
        setRecentOutput(current => current && current.blob === blob ? { ...current, savedPath: saved.path, name: saved.name } : current);
        setSaveStatus(`Saved: ${saved.path}`);
      }
      update({ status: `Done · ${saved.name}`, progress: 100 });
    } catch (error) {
      update({ status: 'Failed', progress: 0, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (jobId) await fetch(`${api}/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
    }
  }

  async function exportCurrent() {
    if ((!active && !frameProject) || (exportOrder === 'edited' && !frameProject) || frameSettingsChanged || running || !outputDirectory || directoryOpen || (!frameProject && !customSizeValid)) return;
    setRunning(true);
    setSaveStatus('Preparing export…');
    let temporaryId = '';
    try {
      await pendingFrameSave.current;
      await pendingMaskSave.current;
      let projectId = frameProject?.id;
      if (!projectId && active) {
        const create = await fetch(`${api}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chroma-Save': '1' }, body: JSON.stringify({ name: active.name, config: { ...settings, startFrame: effectiveStartFrame, endFrame: effectiveEndFrame, sourceFps }, outputDirectory, temporary: true }) });
        if (!create.ok) throw await errorFrom(create);
        const created = await create.json();
        projectId = temporaryId = created.id;
        setSaveStatus('Generating transparent frames…');
        const upload = await fetch(`${api}/projects/${projectId}/source`, { method: 'PUT', headers: { 'X-Chroma-Save': '1', 'Content-Type': 'video/mp4' }, body: active });
        if (!upload.ok) throw await errorFrom(upload);
        for (;;) {
          const response = await fetch(`${api}/projects/${projectId}`, { cache: 'no-store' });
          if (!response.ok) throw await errorFrom(response);
          const state = await response.json();
          if (state.status === 'error') throw new Error(state.error || 'Frame generation failed.');
          if (state.status === 'ready') break;
          await sleep(350);
        }
      }
      setSaveStatus('Exporting frames…');
      const response = await fetch(`${api}/projects/${projectId}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chroma-Save': '1' }, body: JSON.stringify({ format: exportFormat, order: exportOrder, rows: effectiveAtlasRows, directory: outputDirectory, maskProjectId: activeProjectId }) });
      if (!response.ok) throw await errorFrom(response);
      const result = await response.json();
      setSaveStatus(`Saved: ${result.path}`);
    } catch (error) { setSaveStatus(error instanceof Error ? error.message : String(error)); }
    finally {
      if (temporaryId) await fetch(`${api}/projects/${temporaryId}`, { method: 'DELETE', headers: { 'X-Chroma-Save': '1' } }).catch(() => {});
      setRunning(false);
    }
  }

  const currentFrame = Math.min(frame, maxFrame);
  const framePercent = (currentFrame - 1) / Math.max(1, maxFrame - 1) * 100;
  const startPercent = (effectiveStartFrame - 1) / Math.max(1, maxFrame - 1) * 100;
  const endPercent = (effectiveEndFrame - 1) / Math.max(1, maxFrame - 1) * 100;
  const effectiveEndForConfig = activeRange.end === null ? null : effectiveEndFrame;
  const generatedSettings = frameProject?.config as (Settings & { startFrame: number; endFrame: number | null; sourceFps: number; frameTimingVersion?: number }) | undefined;
  const frameSettingsChanged = !!generatedSettings && !!active && duration > 0 && frameGenerationSignature(settings, effectiveStartFrame, effectiveEndFrame, sourceFps) !== frameGenerationSignature(generatedSettings, generatedSettings.startFrame, generatedSettings.endFrame ?? maxFrame, generatedSettings.sourceFps);
  const legacyFrameTiming = !!generatedSettings && generatedSettings.frameTimingVersion !== frameTimingVersion;
  function restoreGeneratedSettings() {
    if (!generatedSettings || !selectedFile) return;
    const { startFrame, endFrame, sourceFps: generatedSourceFps, frameTimingVersion: _generatedTimingVersion, ...savedSettings } = generatedSettings;
    updateProfile(current => ({
      ...current,
      settings: { ...current.settings, ...savedSettings },
      sourceFps: generatedSourceFps,
      frame: startFrame,
      outputFrame: null,
      widthDraft: String(generatedSettings.width),
      heightDraft: String(generatedSettings.height),
    }));
    setRanges(current => new Map(current).set(selectedFile, { start: startFrame, end: endFrame ?? null }));
  }
  function resetOutputSize() {
    const original = generatedSettings || defaults;
    updateProfile(current => ({
      ...current,
      settings: { ...current.settings, size: original.size, width: original.width, height: original.height },
      widthDraft: String(original.width),
      heightDraft: String(original.height),
    }));
  }
  const customSizeValid = settings.size !== 'custom' || [customWidthDraft, customHeightDraft].every(value => /^\d+$/.test(value) && Number(value) >= 16 && Number(value) <= 4096);
  const outputWidth = settings.size === 'original' ? videoSize.width : settings.size === 'custom' ? settings.width : Number(settings.size);
  const outputHeight = settings.size === 'original' ? videoSize.height : settings.size === 'custom' ? settings.height : Number(settings.size);
  const previewOutputWidth = frameProjectPreview?.width ?? outputWidth;
  const previewOutputHeight = frameProjectPreview?.height ?? outputHeight;
  const outputMask = useOutputMask(activeProjectId, previewOutputWidth, previewOutputHeight, sourceRevision, receivePendingMaskSave);
  const outputMaskShortcutsRef = useRef(outputMask);
  outputMaskShortcutsRef.current = outputMask;
  useEffect(() => {
    if (!outputEditOpen || adjustMode !== 'mask') return;
    const onMaskKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('.chroma-single-frame-dialog') || event.altKey || event.metaKey || event.isComposing) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.isContentEditable || target?.closest('input:not([type="range"]), select, textarea')) return;
      const mask = outputMaskShortcutsRef.current;
      if (event.ctrlKey && !event.shiftKey && event.code === 'KeyZ') {
        event.preventDefault();
        if (mask.canUndo && mask.ready) void mask.undo();
      } else if (!event.ctrlKey && !event.shiftKey && (event.code === 'BracketLeft' || event.key === '[')) {
        event.preventDefault();
        mask.setBrushSize(value => Math.max(4, Math.min(mask.maxBrushSize, value - 4)));
      } else if (!event.ctrlKey && !event.shiftKey && (event.code === 'BracketRight' || event.key === ']')) {
        event.preventDefault();
        mask.setBrushSize(value => Math.max(4, Math.min(mask.maxBrushSize, value + 4)));
      }
    };
    window.addEventListener('keydown', onMaskKeyDown);
    return () => window.removeEventListener('keydown', onMaskKeyDown);
  }, [outputEditOpen, adjustMode]);
  const outputMaskStyle: React.CSSProperties | undefined = outputMask.previewUrl ? { maskImage: `url("${outputMask.previewUrl}")`, WebkitMaskImage: `url("${outputMask.previewUrl}")`, maskSize: '100% 100%', WebkitMaskSize: '100% 100%', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat' } : undefined;
  const previewScale = previewStageSize.width && previewOutputWidth ? Math.round(previewStageSize.width / previewOutputWidth * 100) : null;
  const previewStageStyle: React.CSSProperties = {
    aspectRatio: previewOutputWidth && previewOutputHeight ? `${previewOutputWidth} / ${previewOutputHeight}` : undefined,
    ...(previewActualSize && previewOutputWidth && previewOutputHeight ? { width: previewOutputWidth, height: previewOutputHeight, minHeight: 0, boxSizing: 'border-box' as const } : {}),
  };
  const projectPreviewIndex = frameProjectPreview ? previewOrder === 'original' ? Math.min(originalPreviewIndex, frameProjectPreview.originalCount - 1) : frameProjectPreview.index : 0;
  const projectPreviewCount = frameProjectPreview ? previewOrder === 'original' ? frameProjectPreview.originalCount : frameProjectPreview.count : 0;
  const sequencePreviewPlaying = previewOrder === 'original' ? originalPlaying : editedPlaying;
  const projectPreviewSrc = frameProjectPreview ? previewOrder === 'original' ? `${api}/projects/${frameProjectPreview.projectId}/frames/${projectPreviewIndex + 1}` : frameProjectPreview.editedSrc : '';
  const exportFrameCount = frameProject ? exportOrder === 'original' ? frameProject.frameCount : frameProject.slots.length : null;
  const effectiveAtlasRows = Math.min(atlasRows, exportFrameCount ?? atlasRows);
  const { minimum: minimumPreviewSplit, maximum: maximumPreviewSplit } = previewSplitBounds();
  const visiblePreviewSplit = Math.max(minimumPreviewSplit, Math.min(maximumPreviewSplit, previewSplit));
  const baseCropWidth = videoSize.width && videoSize.height && outputWidth && outputHeight ? Math.min(videoSize.width, videoSize.height * outputWidth / outputHeight) : 0;
  const baseCropHeight = outputWidth ? baseCropWidth * outputHeight / outputWidth : 0;
  const cropWidth = baseCropWidth ? Math.max(2, Math.floor(baseCropWidth * settings.cropScale / 2) * 2) : 0;
  const cropHeight = baseCropHeight ? Math.max(2, Math.floor(baseCropHeight * settings.cropScale / 2) * 2) : 0;
  const cropX = Math.round((videoSize.width - cropWidth) * settings.cropX);
  const cropY = Math.round((videoSize.height - cropHeight) * settings.cropY);
  const croppedSource = settings.size !== 'original' && settings.squareMode === 'crop' && cropWidth > 0;
  const croppedSourceStyle: React.CSSProperties = croppedSource ? {
    width: `${videoSize.width / cropWidth * 100}%`,
    height: `${videoSize.height / cropHeight * 100}%`,
    left: `${-cropX / cropWidth * 100}%`,
    top: `${-cropY / cropHeight * 100}%`,
  } : {};
  const baseCropWidthRounded = baseCropWidth ? Math.max(2, Math.floor(baseCropWidth / 2) * 2) : 0;
  const editZoom = cropWidth ? baseCropWidthRounded / cropWidth : 1;
  // The editing stage has the source video's aspect ratio. Use the same zoom on
  // both axes so the picture keeps its proportions, then size the fixed frame
  // from the actual source crop that FFmpeg will use.
  const editImageWidthPercent = 100 * editZoom;
  const editImageHeightPercent = 100 * editZoom;
  const editFrameWidthPercent = videoSize.width ? cropWidth * editZoom / videoSize.width * 100 : 0;
  const editFrameHeightPercent = videoSize.height ? cropHeight * editZoom / videoSize.height * 100 : 0;
  const editCropX = Math.round((videoSize.width - cropWidth) * (cropDraft?.x ?? settings.cropX));
  const editCropY = Math.round((videoSize.height - cropHeight) * (cropDraft?.y ?? settings.cropY));
  const editImageStyle: React.CSSProperties = cropWidth ? {
    width: `${editImageWidthPercent}%`,
    height: `${editImageHeightPercent}%`,
    left: `${(100 - editFrameWidthPercent) / 2 - editCropX / videoSize.width * editImageWidthPercent}%`,
    top: `${(100 - editFrameHeightPercent) / 2 - editCropY / videoSize.height * editImageHeightPercent}%`,
  } : {};
  const editFrameStyle: React.CSSProperties = cropWidth ? {
    width: `${editFrameWidthPercent}%`,
    height: `${editFrameHeightPercent}%`,
    left: `${(100 - editFrameWidthPercent) / 2}%`,
    top: `${(100 - editFrameHeightPercent) / 2}%`,
  } : {};
  const generatedForeground = frameProject?.config as { foregroundZoom?: number; foregroundX?: number; foregroundY?: number } | undefined;
  const previewZoom = frameProject ? settings.foregroundZoom / (generatedForeground?.foregroundZoom || 1) : settings.foregroundZoom;
  const previewX = frameProject ? settings.foregroundX - previewZoom * (generatedForeground?.foregroundX || 0) : settings.foregroundX;
  const previewY = frameProject ? settings.foregroundY - previewZoom * (generatedForeground?.foregroundY || 0) : settings.foregroundY;
  const foregroundStyle: React.CSSProperties = { transform: `translate(${previewX * 100}%, ${previewY * 100}%) scale(${previewZoom})` };
  const frameEdit = previewOrder === 'edited' ? frameProjectPreview?.edit : undefined;
  const editedForegroundStyle: React.CSSProperties = frameEdit ? { transform: `translate(${(previewX + frameEdit.x * previewZoom) * 100}%, ${(previewY + frameEdit.y * previewZoom) * 100}%) scale(${previewZoom * frameEdit.zoom})` } : foregroundStyle;
  const frameMaskUrl = frameEdit?.maskId && frameProjectPreview ? `${api}/projects/${frameProjectPreview.projectId}/frame-masks/${frameEdit.maskId}` : '';
  const frameMaskStyle: React.CSSProperties | undefined = frameMaskUrl ? { maskImage: `url("${frameMaskUrl}")`, WebkitMaskImage: `url("${frameMaskUrl}")`, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' } : undefined;

  return <main className="chroma-page">
    <header className="chroma-module-header">
      <div className="chroma-module-brand"><span className="chroma-module-mark"><Film size={17}/></span><strong>MP4 BG <span>Removal</span></strong><span className="chroma-module-subtitle">Green screen · WebP / PNG</span></div>
      <div className="chroma-local"><i/>Fully local processing</div>
    </header>
    <div ref={layoutRef} className={`chroma-layout ${filesCollapsed ? 'files-collapsed' : ''} ${settingsCollapsed ? 'settings-collapsed' : ''}`} style={{ '--chroma-settings-width': `${settingsPanelWidth}px`, '--chroma-files-width': `${filesPanelWidth}px` } as React.CSSProperties}>
      <div className="chroma-files-shell">
      <section className={`chroma-panel chroma-files ${filesCollapsed ? 'collapsed' : ''}`}>
        <div className="chroma-panel-title"><span>01 / Files</span><strong>{files.length} MP4 files</strong><button className="chroma-panel-toggle" type="button" aria-label={filesCollapsed ? 'Expand file list' : 'Collapse file list'} title={filesCollapsed ? 'Expand file list' : 'Collapse file list'} onClick={() => setFilesCollapsed(value => !value)}>{filesCollapsed ? <ChevronRight size={16}/> : <ChevronLeft size={16}/>}</button></div>
        <div className={`chroma-drop ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!running) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!running) addFiles(event.dataTransfer.files); }} onClick={() => { if (!running) fileInput.current?.click(); }} role="button" tabIndex={running ? -1 : 0} aria-disabled={running} onKeyDown={event => { if (event.key === 'Enter' && !running) fileInput.current?.click(); }}>
          <Upload size={27}/><b>Drop MP4 files here</b><span>or click to choose files</span>
        </div>
        <input ref={fileInput} type="file" accept="video/mp4,.mp4" multiple hidden onChange={event => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }}/>
        <div className="chroma-list">{files.map((file, index) => { const state = states[fileKey(file, index)]; const id = projectIds.get(file); return <div key={id || fileKey(file, index)} className={`chroma-file ${selected === index ? 'selected' : ''}`} onClick={() => { if (!running) setSelected(index); }}>
          <Film size={17}/><div className="chroma-file-name"><b title={file.name}>{file.name}</b><span>{((sourceSizes.get(file) || file.size) / 1024 / 1024).toFixed(1)} MB · {id && missingSourceIds.has(id) ? 'Source MP4 missing' : state?.status || (active === file ? 'Ready' : 'Saved locally')}</span>{id && sourceErrors[id] && <em title={sourceErrors[id]}>{sourceErrors[id]}</em>}{state?.error && <em title={state.error}>{state.error}</em>}{state && state.progress > 0 && state.progress < 100 && <i style={{ width: `${state.progress}%` }}/>}</div>
          {id && missingSourceIds.has(id) && !running && <button type="button" className="chroma-relink-button" title="Choose the same MP4, even if renamed" onClick={event => { event.stopPropagation(); relinkTargetId.current = id; relinkInput.current?.click(); }}>Relink</button>}
          {!running && <button title="Remove saved file and edits" onClick={event => { event.stopPropagation(); void removeFile(index); }}><Trash2 size={15}/></button>}
        </div>; })}</div>
        <input ref={relinkInput} type="file" accept="video/mp4,.mp4" hidden onChange={event => { const candidate = event.target.files?.[0]; const id = relinkTargetId.current; event.target.value = ''; if (candidate && id) void relinkMissingSource(id, candidate); }}/>
        {files.length > 0 && <button className="chroma-add" disabled={running} onClick={() => fileInput.current?.click()}><Plus size={16}/> Add more videos</button>}
      </section>
      {!filesCollapsed && <div className={`chroma-files-resize ${filesResizing ? 'dragging' : ''}`} role="separator" tabIndex={0} aria-label="Resize files panel" aria-orientation="vertical" aria-valuemin={205} aria-valuemax={maxFilesPanelWidth()} aria-valuenow={filesPanelWidth} title="Drag to resize the files panel; double-click to reset" onPointerDown={onFilesResizeStart} onKeyDown={onFilesResizeKey} onDoubleClick={() => setFilesPanelWidth(Math.round(Math.min(550, Math.max(250, window.innerWidth * .28))))}/>}</div>
      <section className="chroma-panel chroma-preview-panel">
        <div className="chroma-panel-title"><span>02 / Live frame preview</span><strong>{videoSize.width ? `${videoSize.width} × ${videoSize.height}` : active?.name || 'No file selected'}</strong></div>
        <div className="chroma-crop-toolbar"><div className="chroma-fit-picker"><label htmlFor="chroma-fit-mode">Frame fitting</label><select id="chroma-fit-mode" value={settings.size === 'original' ? 'original' : settings.squareMode} onChange={event => applyFitMode(event.target.value as 'original' | Settings['squareMode'])}><option value="original">Keep original size</option><option value="crop">Crop to output ratio</option><option value="pad">Scale to fit + transparent padding</option></select></div>{croppedSource && <div className="chroma-crop-dimensions">Crop area <b>{cropWidth} × {cropHeight}</b></div>}</div>
        <div ref={previewGridRef} className="chroma-preview-grid" style={{ gridTemplateColumns: `${visiblePreviewSplit}fr 12px ${1 - visiblePreviewSplit}fr` }}>
          <div className="chroma-source-pane">
            <div className="chroma-source-heading"><div className="chroma-preview-label">{cropEditing ? 'Source · drag inside the white frame' : croppedSource ? 'Cropped source' : 'Source frame'}</div><button type="button" disabled={!active || !activeProjectId || running} onClick={() => replaceInput.current?.click()}><Upload size={13}/> Re-upload MP4</button><input ref={replaceInput} type="file" accept="video/mp4,.mp4" hidden onChange={event => { const replacement = event.target.files?.[0]; event.target.value = ''; if (replacement) void replaceCurrentSource(replacement); }}/></div>
            <div className={`chroma-stage chroma-original-stage ${sourcePlaying ? 'playing' : ''} ${cropEditing ? 'editing' : ''} ${cropDragging ? 'dragging' : ''} ${croppedSource && !cropEditing ? 'cropped' : ''}`} style={videoSize.width && videoSize.height ? { aspectRatio: croppedSource && !cropEditing && outputWidth && outputHeight ? `${outputWidth} / ${outputHeight}` : `${videoSize.width} / ${videoSize.height}` } : undefined} onPointerDown={onCropPointerDown} onPointerMove={onCropPointerMove} onPointerUp={onCropPointerEnd} onPointerCancel={onCropPointerEnd}>
              <video ref={videoRef} src={sourceUrl || undefined} preload="auto" muted playsInline className="chroma-source-video" style={croppedSource && !cropEditing ? croppedSourceStyle : undefined} onLoadedMetadata={event => { setDuration(event.currentTarget.duration); setVideoSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight }); }} onLoadedData={captureFrame} onSeeked={captureFrame} onTimeUpdate={onSourceTimeUpdate} onEnded={() => { if (sourcePlayingRef.current && videoRef.current) { videoRef.current.currentTime = (effectiveStartFrame - 1) / sourceFps; void videoRef.current.play().catch(() => stopSourcePlayback()); } }}/>
              {frameUrl ? <img className="chroma-source-still" src={frameUrl} style={croppedSource && !cropEditing ? croppedSourceStyle : undefined} alt={croppedSource && !cropEditing ? 'Cropped source frame' : 'Original video frame'}/> : !sourcePlaying && <span>Waiting for a file</span>}
              {cropEditing && frameUrl && <><img className="chroma-edit-image" src={frameUrl} style={editImageStyle} alt="Draggable source frame" draggable={false}/><div className="chroma-edit-crop-frame" style={editFrameStyle} title="Drag the source frame"/></>}
            </div>
            <div className="chroma-playback-controls">
              <button disabled={!active || !duration || cropEditing} onClick={toggleSourcePlayback}>{sourcePlaying ? <Pause size={14}/> : <Play size={14}/>} {sourcePlaying ? 'Stop source playback' : 'Play source interval'}</button>
              <button disabled={!active || !videoSize.width || (settings.size !== 'original' && (!cropWidth || settings.squareMode !== 'crop'))} onClick={startCropEditor}><Crop size={14}/> {cropEditing ? 'Finish crop' : settings.size === 'original' ? 'Start crop' : 'Edit crop'}</button>
            </div>
            {cropEditing && <div className="chroma-crop-edit-controls"><label>Zoom <b>{Math.round(100 / settings.cropScale)}%</b></label><input aria-label="Crop zoom" type="range" min="1" max="2" step="0.01" value={1 / settings.cropScale} onChange={event => setSettings(current => ({ ...current, cropScale: 1 / Number(event.target.value) }))}/><button onClick={() => setSettings(current => ({ ...current, cropScale: 1, cropX: .5, cropY: .5 }))}><RotateCcw size={13}/> Reset</button><small>Drag the image inside the white frame. Release to update the output preview.</small></div>}
            <div className="chroma-frame-controls"><div className="chroma-control-line"><label>Preview frame <b>#{currentFrame}</b></label><span>{((currentFrame - 1) / sourceFps).toFixed(2)}s / {duration.toFixed(2)}s</span></div><div className={`chroma-timeline ${!active || !duration ? 'disabled' : ''}`} onPointerDown={onTimelinePointerDown} onPointerMove={onTimelinePointerMove} onPointerUp={onTimelinePointerEnd} onPointerCancel={onTimelinePointerEnd} onLostPointerCapture={() => { timelineDrag.current = null; }}><div className="chroma-timeline-track"/><div className="chroma-timeline-selection" style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }}/><div className="chroma-timeline-playhead" data-handle="frame" style={{ left: `${framePercent}%` }} title={`Current preview frame #${currentFrame}`}/><div className="chroma-timeline-handle start" data-handle="start" role="slider" tabIndex={active ? 0 : -1} aria-label="Start frame" aria-valuemin={1} aria-valuemax={effectiveEndFrame} aria-valuenow={effectiveStartFrame} onKeyDown={event => onTimelineHandleKey(event, 'start')} style={{ left: `${startPercent}%` }} title={`Start frame #${effectiveStartFrame}`}/><div className="chroma-timeline-handle end" data-handle="end" role="slider" tabIndex={active ? 0 : -1} aria-label="End frame" aria-valuemin={effectiveStartFrame} aria-valuemax={maxFrame} aria-valuenow={effectiveEndFrame} onKeyDown={event => onTimelineHandleKey(event, 'end')} style={{ left: `${endPercent}%` }} title={`End frame #${effectiveEndFrame}`}/></div><div className="chroma-timeline-info"><button type="button" aria-label={`Jump to first selected frame #${effectiveStartFrame}`} disabled={!active || !duration} onClick={() => jumpToRangeFrame(effectiveStartFrame)}><SkipBack size={13}/> First <b>#{effectiveStartFrame}</b></button><span>Interval <b>{((effectiveEndFrame - effectiveStartFrame + 1) / sourceFps).toFixed(2)} s</b></span><button type="button" aria-label={`Jump to last selected frame #${effectiveEndFrame}`} disabled={!active || !duration} onClick={() => jumpToRangeFrame(effectiveEndFrame)}>Last <b>#{effectiveEndFrame}</b> <SkipForward size={13}/></button></div><div className="chroma-frame-bottom">Drag the white handles to set the interval; click the timeline to inspect a frame</div></div>
          </div>
          <div className={`chroma-preview-resize ${previewResizing ? 'dragging' : ''}`} role="separator" tabIndex={0} aria-label="Resize source and output previews" aria-orientation="vertical" aria-valuemin={Math.round(minimumPreviewSplit * 100)} aria-valuemax={Math.round(maximumPreviewSplit * 100)} aria-valuenow={Math.round(visiblePreviewSplit * 100)} title="Drag to resize source and output previews; double-click to reset" onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setPreviewResizing(true); updatePreviewSplit(event.clientX); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePreviewSplit(event.clientX); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setPreviewResizing(false); }} onPointerCancel={() => setPreviewResizing(false)} onLostPointerCapture={() => setPreviewResizing(false)} onKeyDown={onPreviewResizeKey} onDoubleClick={() => setPreviewSplit(.5)}/>
          <div className="chroma-output-pane">
            <div className="chroma-output-heading"><div className="chroma-preview-label">Output</div><div className="chroma-preview-dimensions" aria-label="Preview window dimensions">{previewStageSize.width > 0 && <span className="chroma-preview-size-full">Preview window <b>{previewStageSize.width} × {previewStageSize.height}</b> CSS px</span>}{previewScale !== null && <span className="chroma-preview-scale-full">Shown at <b>{previewScale}%</b></span>}{previewStageSize.width > 0 && previewScale !== null && <span className="chroma-preview-size-compact">{previewStageSize.width} × {previewStageSize.height} px · {previewScale}%</span>}</div><button type="button" className="chroma-preview-size-button" disabled={!previewOutputWidth || !previewOutputHeight} aria-pressed={previewActualSize} onClick={() => setPreviewActualSize(value => !value)}>{previewActualSize ? 'Fit window' : 'Show at 100%'}</button></div>
            <video ref={outputVideoRef} src={sourceUrl || undefined} preload="auto" muted playsInline hidden onLoadedMetadata={seekOutputVideo} onLoadedData={captureOutputFrame} onSeeked={captureOutputFrame}/>
            <div className={`chroma-output-stage-viewport ${previewActualSize ? 'actual-size' : ''}`}>
            <div ref={outputStageRef} className={`chroma-stage chroma-output-stage checker ${outputEditOpen ? 'editing' : ''} ${foregroundDragging ? 'dragging' : ''} ${previewCue && frameProjectPreview ? 'preview-switched' : ''}`} style={previewStageStyle}>
              {backgroundUrl && <img className={`chroma-preview-background ${backgroundOriginalSize ? 'original-size' : ''}`} src={backgroundUrl} alt="Custom preview background"/>}
              <div className="chroma-output-foreground" style={outputMaskStyle}>
                {frameProjectPreview ? projectPreviewSrc ? <div className="chroma-output-slot-mask" style={frameMaskStyle}><img className="chroma-output-image" src={projectPreviewSrc} style={editedForegroundStyle} alt={`${previewOrder === 'original' ? 'Original' : 'Edited'} frame ${projectPreviewIndex + 1}`}/></div> : <span>Transparent frame #{projectPreviewIndex + 1}</span> : hasCachedPreview ? <video ref={playbackVideoRef} className="chroma-output-video" src={previewCache.url} style={foregroundStyle} muted playsInline loop preload="auto" aria-label="Cached transparent interval preview" onTimeUpdate={event => { if (animationPlaying) setOutputFrame(Math.max(effectiveStartFrame, Math.min(effectiveEndFrame, effectiveStartFrame + Math.round(event.currentTarget.currentTime * sourceFps)))); }}/>: previewUrl ? <img className="chroma-output-image" src={previewUrl} style={foregroundStyle} alt="Transparent keyed and cropped preview"/> : <span>{previewStatus}</span>}
              </div>
              {outputEditOpen && adjustMode === 'mask' && showMaskOverlay && outputMask.overlayUrl && <img className="chroma-mask-overlay" src={outputMask.overlayUrl} alt="" aria-hidden="true"/>}
              {outputEditOpen && adjustMode === 'position' && foregroundMoveActive && <div className="chroma-foreground-drag-layer" role="button" tabIndex={0} aria-label="Drag transparent foreground" onPointerDown={onForegroundPointerDown} onPointerMove={onForegroundPointerMove} onPointerUp={onForegroundPointerEnd} onPointerCancel={onForegroundPointerEnd} onKeyDown={event => { const step = event.shiftKey ? 0.05 : 0.01; const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0; const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0; if (!dx && !dy) return; event.preventDefault(); setSettings(current => ({ ...current, foregroundX: Math.max(-1, Math.min(1, current.foregroundX + dx)), foregroundY: Math.max(-1, Math.min(1, current.foregroundY + dy)) })); }}/>}
              {outputEditOpen && adjustMode === 'mask' && <div className="chroma-mask-paint-layer" aria-label="Paint output mask" onPointerDown={outputMask.onPointerDown} onPointerMove={outputMask.onPointerMove} onPointerUp={outputMask.onPointerEnd} onPointerCancel={outputMask.onPointerEnd} onPointerLeave={() => outputMask.setCursor(null)}>
                {outputMask.cursor && <span
                  className={`chroma-mask-brush-cursor ${outputMask.action} ${outputMask.edge}`}
                  style={{
                    left: `${outputMask.cursor.x / previewOutputWidth * 100}%`,
                    top: `${outputMask.cursor.y / previewOutputHeight * 100}%`,
                    width: `${outputMask.brushSize / previewOutputWidth * 100}%`,
                    height: `${outputMask.brushSize / previewOutputHeight * 100}%`,
                    backgroundImage: `url("${outputMask.brushStamps.cursor}")`,
                    backgroundSize: '100% 100%',
                  }}
                />}
              </div>}
              {previewCue && frameProjectPreview && <span key={previewCue.key} className={`chroma-preview-switch-cue ${previewCue.order}`} role="status">{previewCue.order === 'edited' ? 'Edited sequence · timeline ready' : 'Original sequence · timeline locked'}</span>}
            </div>
            </div>
            {frameProjectPreview ? <div className="chroma-output-scrubber">
              <div>
                <label>Frame preview · {previewOrder === 'edited' ? 'Edited' : 'Original'}</label>
                {previewOrder === 'edited' && frameProjectPreview.blendKind && <span className={`chroma-output-blend-tag ${frameProjectPreview.blendKind}`}>{frameProjectPreview.blendKind === 'loop' ? 'Loop blend' : frameProjectPreview.blendKind === 'pair' ? 'Pair blend' : 'Blend frame'}</span>}
                <button type="button" className="chroma-sequence-play" aria-label={`${sequencePreviewPlaying ? 'Pause' : 'Play'} ${previewOrder} preview`} aria-pressed={sequencePreviewPlaying} onClick={() => { if (previewOrder === 'original') setOriginalPlaying(value => !value); else { if (!editedPlaying) editedPlayhead.current = frameProjectPreview.index; setEditedPlaying(value => !value); } }}>{sequencePreviewPlaying ? <Pause size={13}/> : <Play size={13}/>} {sequencePreviewPlaying ? 'Pause preview' : 'Play preview'}</button>
                <b>#{projectPreviewIndex + 1} / {projectPreviewCount}</b>
              </div>
              <div className={`chroma-order-switch chroma-preview-order-switch ${previewOrder}`} role="group" aria-label="Preview frame order"><button type="button" className={previewOrder === 'original' ? 'active' : ''} aria-pressed={previewOrder === 'original'} onClick={() => switchPreviewOrder('original')}>Original</button><button type="button" className={previewOrder === 'edited' ? 'active' : ''} aria-pressed={previewOrder === 'edited'} onClick={() => switchPreviewOrder('edited')}>Edited</button></div>
              <input aria-label={previewOrder === 'original' ? 'Original frame preview' : 'Edited frame preview'} type="range" min="0" max={Math.max(0, projectPreviewCount - 1)} step="1" value={projectPreviewIndex} onChange={event => { const index = Number(event.target.value); if (previewOrder === 'original') { setOriginalPlaying(false); setOriginalPreviewIndex(index); } else { setEditedPlaying(false); editedPlayhead.current = index; setEditedPreviewSeek({ projectId: frameProjectPreview.projectId, index, token: ++editedSeekToken.current }); } }}/>
            </div> : <div className="chroma-output-scrubber"><div><label htmlFor="chroma-output-frame">Output frame preview{hasCachedPreview ? ' · Cached' : ''}</label><b>#{effectiveOutputFrame}</b>{outputFrame !== null && <button type="button" onClick={() => { stopPlayback(); outputRequestedFrame.current = null; setOutputFrameCapture(null); setOutputFrame(null); }}>Follow source frame</button>}</div><input id="chroma-output-frame" aria-label="Output frame preview" type="range" min={effectiveStartFrame} max={effectiveEndFrame} step="1" value={effectiveOutputFrame} disabled={!active || !duration || effectiveStartFrame === effectiveEndFrame} onChange={event => previewOutputFrame(Number(event.target.value))}/></div>}
            {!frameProjectPreview && <div className="chroma-playback-controls"><button disabled={!active || !duration || !customSizeValid} title={hasCachedPreview ? 'Play the cached transparent interval' : 'Generate and play the transparent interval'} onClick={previewRendering || animationPlaying ? () => stopPlayback() : playSelectedRange}>{previewRendering ? <RefreshCw size={14} className="chroma-spin"/> : animationPlaying ? <Pause size={14}/> : <Play size={14}/>} {previewRendering ? 'Stop generation' : animationPlaying ? 'Pause playback' : 'Play preview'}</button></div>}
            <input ref={backgroundInput} type="file" accept="image/*" hidden onChange={event => { const file = event.target.files?.[0]; if (file) updateBackground(file); event.target.value = ''; }}/>
            {(playbackStatus || previewRendering) && <div className="chroma-playback-status" role="status">{playbackStatus}{previewRendering && <i style={{ width: `${playbackProgress}%` }}/>}</div>}
          </div>
        </div>
        <div className="chroma-preview-status"><RefreshCw size={13}/>{frameProjectPreview ? 'Viewing saved frame project' : previewStatus}</div>
      </section>
      <div className="chroma-settings-shell">
        {!settingsCollapsed && <div className={`chroma-settings-resize ${settingsResizing ? 'dragging' : ''}`} role="separator" tabIndex={0} aria-label="Resize settings panel" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={760} aria-valuenow={settingsPanelWidth} title="Drag to resize the settings panel" onPointerDown={onSettingsResizeStart} onKeyDown={onSettingsResizeKey}/>}
      <section className={`chroma-panel chroma-settings ${settingsCollapsed ? 'collapsed' : ''}`}>
        <div className="chroma-panel-title"><span>03 / Properties</span><button className="chroma-panel-toggle" type="button" aria-label={settingsCollapsed ? 'Expand settings panel' : 'Collapse settings panel'} title={settingsCollapsed ? 'Expand settings panel' : 'Collapse settings panel'} onClick={() => setSettingsCollapsed(value => !value)}>{settingsCollapsed ? <ChevronLeft size={16}/> : <ChevronRight size={16}/>}</button></div>
        <div className="chroma-properties-tabs" role="tablist" aria-label="Properties">
          <button type="button" id="chroma-export-tab" role="tab" aria-controls="chroma-export-panel" aria-selected={!outputEditOpen} className={!outputEditOpen ? 'active' : ''} onClick={() => { foregroundDrag.current = null; setForegroundDragging(false); setForegroundMoveActive(false); setOutputEditOpen(false); }}>Export</button>
          <button type="button" id="chroma-output-edit-tab" role="tab" aria-controls="chroma-output-edit-panel" aria-selected={outputEditOpen} className={outputEditOpen ? 'active' : ''} onClick={() => setOutputEditOpen(true)}>Output Edit</button>
        </div>
        {outputEditOpen ? <div className="chroma-output-edit-panel" id="chroma-output-edit-panel" role="tabpanel" aria-labelledby="chroma-output-edit-tab">
          <section className="chroma-background-panel" aria-labelledby="chroma-background-heading">
            <h3 id="chroma-background-heading">Background</h3>
            <div className="chroma-background-actions">
              <button type="button" disabled={!active && !frameProjectPreview} onClick={() => backgroundInput.current?.click()}><Upload size={14}/> {backgroundName ? 'Change background' : 'Upload background'}</button>
              {backgroundUrl && <button type="button" className={`chroma-background-size-toggle ${backgroundOriginalSize ? 'active' : ''}`} aria-pressed={backgroundOriginalSize} title="Show the uploaded background at its original pixel size" onClick={() => updateProfile(current => ({ ...current, backgroundOriginalSize: current.backgroundOriginalSize === false }))}>Original size</button>}
              {backgroundUrl && <button type="button" className="chroma-background-remove" onClick={clearBackground} title="Restore checkerboard"><X size={14}/> Remove</button>}
            </div>
            <small>The background is preview-only and is not exported.</small>
          </section>
          <section className="chroma-foreground-controls" aria-labelledby="chroma-adjust-heading">
            <h3 id="chroma-adjust-heading">Adjust</h3>
            <div className="chroma-adjust-mode" role="tablist" aria-label="Output adjustment mode">
              <button type="button" role="tab" aria-selected={adjustMode === 'position'} className={adjustMode === 'position' ? 'active' : ''} onClick={() => setAdjustMode('position')}><Move size={14}/> Position</button>
              <button type="button" role="tab" aria-selected={adjustMode === 'mask'} className={adjustMode === 'mask' ? 'active' : ''} onClick={() => { foregroundDrag.current = null; setForegroundDragging(false); setForegroundMoveActive(false); setAdjustMode('mask'); }}><Brush size={14}/> Mask</button>
            </div>
            {adjustMode === 'position' ? <div className="chroma-adjust-section" role="tabpanel">
              <h4>Foreground position</h4>
              <button type="button" className={`chroma-foreground-move-button ${foregroundMoveActive ? 'active' : ''}`} aria-pressed={foregroundMoveActive} disabled={!active && !frameProjectPreview} onClick={() => { foregroundDrag.current = null; setForegroundDragging(false); setForegroundMoveActive(value => !value); }}><Move size={14}/> Move</button>
              <label htmlFor="chroma-foreground-zoom">Foreground zoom <b>{settings.foregroundZoom.toFixed(2)}×</b></label>
              <input id="chroma-foreground-zoom" type="range" min="0.5" max="2" step="0.01" value={settings.foregroundZoom} onChange={event => setSettings(current => ({ ...current, foregroundZoom: Number(event.target.value) }))}/>
              <div className="chroma-position-actions"><span>{foregroundMoveActive ? 'Drag the preview to reposition the foreground.' : 'Click Move to reposition the foreground.'}</span><div className="chroma-foreground-reset-actions"><button type="button" onClick={() => setSettings(current => ({ ...current, foregroundZoom: 1 }))}><RotateCcw size={13}/> Reset zoom</button><button type="button" onClick={() => setSettings(current => ({ ...current, foregroundX: 0, foregroundY: 0 }))}><RotateCcw size={13}/> Reset position</button></div></div>
            </div> : <div className="chroma-adjust-section chroma-mask-controls" role="tabpanel">
              <div className="chroma-mask-section-heading"><div><h4>Output mask</h4><p>Paint once for every frame. Red marks erased areas; the overlay is preview-only.</p></div><button type="button" className={`chroma-mask-visibility ${showMaskOverlay ? 'active' : ''}`} role="switch" aria-checked={showMaskOverlay} onClick={() => setShowMaskOverlay(value => !value)}><i/> Show mask <span className="chroma-switch-track" aria-hidden="true"/></button></div>
              <fieldset className="chroma-mask-field"><legend>Brush action</legend><div className="chroma-mask-options" role="group" aria-label="Mask brush action"><button type="button" className={outputMask.action === 'erase' ? 'active' : ''} aria-pressed={outputMask.action === 'erase'} onClick={() => outputMask.setAction('erase')}><Eraser size={14}/> Erase</button><button type="button" className={outputMask.action === 'restore' ? 'active' : ''} aria-pressed={outputMask.action === 'restore'} onClick={() => outputMask.setAction('restore')}><Brush size={14}/> Restore</button></div></fieldset>
              <fieldset className="chroma-mask-field"><legend>Brush edge</legend><div className="chroma-mask-options" role="group" aria-label="Mask brush edge"><button type="button" className={outputMask.edge === 'hard' ? 'active' : ''} aria-pressed={outputMask.edge === 'hard'} onClick={() => outputMask.setEdge('hard')}>Hard edge</button><button type="button" className={outputMask.edge === 'soft' ? 'active' : ''} aria-pressed={outputMask.edge === 'soft'} onClick={() => outputMask.setEdge('soft')}>Soft edge</button></div></fieldset>
              {outputMask.edge === 'soft' && <div className="chroma-mask-softness-field"><label htmlFor="chroma-mask-softness">Edge softness <b>{outputMask.softness}%</b></label><input id="chroma-mask-softness" type="range" min="0" max="100" step="1" value={outputMask.softness} onChange={event => outputMask.setSoftness(Number(event.target.value))}/><div className="chroma-mask-softness-ends"><span>Sharper</span><span>Softer</span></div></div>}
              <div className="chroma-mask-size-field"><label htmlFor="chroma-mask-size">Brush size <b>{outputMask.brushSize} px</b></label><input id="chroma-mask-size" type="range" min="4" max={outputMask.maxBrushSize} step="1" value={outputMask.brushSize} onChange={event => outputMask.setBrushSize(Number(event.target.value))}/><small>[ / ] resize brush · Ctrl+Z undo stroke</small></div>
              <div className="chroma-mask-brush-preview"><div className="chroma-brush-preview-checker" role="img" aria-label={`${outputMask.edge === 'soft' ? `${outputMask.softness}% soft` : 'Hard edge'} ${outputMask.action} brush preview`}><img src={outputMask.brushStamps.preview} alt=""/></div><span>Brush preview<small>{outputMask.edge === 'soft' ? `Soft edge · ${outputMask.softness}%` : 'Hard edge'} · {outputMask.brushSize} px</small></span></div>
              <div className="chroma-mask-actions"><button type="button" onClick={() => void outputMask.undo()} disabled={!outputMask.canUndo}>Undo stroke</button><button type="button" onClick={outputMask.reset} disabled={!outputMask.previewUrl}>Reset mask</button></div>
              <small role="status">{outputMask.ready ? outputMask.status : 'Loading mask…'}</small>
            </div>}
          </section>
        </div> : <div className="chroma-export-panel" id="chroma-export-panel" role="tabpanel" aria-labelledby="chroma-export-tab">
        <div className="chroma-field"><label>Chroma key color</label><div className="chroma-color"><input type="color" aria-label="Custom chroma key color" value={settings.color} onChange={event => setSettings({ ...settings, color: event.target.value.toUpperCase() })}/><code>{settings.color}</code></div><div className="chroma-color-presets" role="group" aria-label="Standard chroma key colors"><button type="button" className={settings.color.toUpperCase() === '#00FF00' ? 'active' : ''} aria-pressed={settings.color.toUpperCase() === '#00FF00'} onClick={() => setSettings(current => ({ ...current, color: '#00FF00' }))}><i className="green"/> Green #00FF00</button><button type="button" className={settings.color.toUpperCase() === '#FF00DD' ? 'active' : ''} aria-pressed={settings.color.toUpperCase() === '#FF00DD'} onClick={() => setSettings(current => ({ ...current, color: '#FF00DD' }))}><i className="magenta"/> Magenta #FF00DD</button></div></div>
        <div className="chroma-field"><label>Similarity <b>{settings.similarity.toFixed(2)}</b></label><input type="range" min="0.01" max="1" step="0.01" value={settings.similarity} onChange={event => setSettings({ ...settings, similarity: Number(event.target.value) })}/><small>Higher values remove more similar green</small></div>
        <div className="chroma-field"><label>Blend / Feather <b>{settings.blend.toFixed(2)}</b></label><input type="range" min="0" max="1" step="0.01" value={settings.blend} onChange={event => setSettings({ ...settings, blend: Number(event.target.value) })}/><small>Softens the transparency transition at edges</small></div>
        <div className="chroma-settings-row"><div className="chroma-field"><label>Source FPS</label><input type="number" min="1" max="120" step="0.001" value={sourceFps} onChange={event => setSourceFps(Math.max(1, Math.min(120, Number(event.target.value) || 1)))}/>{detectedFps && <small className={Math.abs(sourceFps - detectedFps) > 0.01 ? 'chroma-fps-mismatch' : ''}>Detected video: {Number(detectedFps.toFixed(3))} FPS{Math.abs(sourceFps - detectedFps) > 0.01 && <button type="button" onClick={() => setSourceFps(Number(detectedFps.toFixed(3)))}>Use detected</button>}</small>}</div><div className="chroma-field"><label>Output FPS</label><input type="number" min="1" max="60" value={settings.fps} onChange={event => setSettings({ ...settings, fps: Math.max(1, Math.min(60, Number(event.target.value) || 1)) })}/></div></div>
        <div className="chroma-field chroma-output-size"><label>Output size <button type="button" className="chroma-size-reset" aria-label="Reset output size" onClick={resetOutputSize} title={generatedSettings ? 'Restore the size used to generate these PNG frames' : 'Restore original video size'}><RotateCcw size={12}/> Reset size</button></label><select value={settings.size} onChange={event => setSettings({ ...settings, size: event.target.value })}><option value="original">Keep original size</option><option value="256">256 × 256</option><option value="512">512 × 512</option><option value="1024">1024 × 1024</option><option value="custom">Custom dimensions…</option></select></div>
        {settings.size === 'custom' && <div className="chroma-custom-size"><label>Width <input aria-label="Custom width" type="number" min="16" max="4096" value={customWidthDraft} onChange={event => updateCustomDimension('width', event.target.value)} onBlur={() => normalizeCustomDimension('width')}/></label><span>×</span><label>Height <input aria-label="Custom height" type="number" min="16" max="4096" value={customHeightDraft} onChange={event => updateCustomDimension('height', event.target.value)} onBlur={() => normalizeCustomDimension('height')}/></label>{!customSizeValid && <small>Enter integer dimensions from 16 to 4096.</small>}</div>}
        <div className="chroma-field"><label>Output folder</label><button className="chroma-folder" onClick={chooseFolder} title="Choose output folder" disabled={running}><FolderOpen size={16}/><span>{outputLabel}</span></button>{directoryOpen && <div className="chroma-directory-editor"><label htmlFor="chroma-directory-path">Full path to a local folder</label><input id="chroma-directory-path" value={directoryDraft} onChange={event => setDirectoryDraft(event.target.value)} placeholder="For example C:\\Users\\Administrator\\Pictures"/><div><button onClick={pickFolderNative} disabled={directoryPicking}>{directoryPicking ? 'Waiting for folder selection…' : 'Browse folders'}</button><button onClick={applyDirectory} disabled={directoryPicking}>Use this folder</button><button onClick={() => { setDirectoryDraft(defaultDirectory); setDirectoryError(''); }} disabled={directoryPicking}>Use default path</button></div>{directoryError && <em>{directoryError}</em>}</div>}<button className="chroma-open-folder" onClick={openSelectedFolder} disabled={!outputDirectory}><FolderOpen size={15}/> Open folder</button>{folderError && <small className="chroma-folder-error">{folderError}</small>}</div>
        <div className="chroma-field"><label>Export frame order</label><div className="chroma-order-switch" role="group" aria-label="Export frame order"><button type="button" className={exportOrder === 'original' ? 'active' : ''} aria-pressed={exportOrder === 'original'} onClick={() => setExportOrder('original')}>Original</button><button type="button" className={exportOrder === 'edited' ? 'active' : ''} aria-pressed={exportOrder === 'edited'} disabled={!frameProject} onClick={() => setExportOrder('edited')}>Edited</button></div>{frameProject && exportFrameCount !== null && <small>{exportFrameCount} frames · {(exportFrameCount / frameProject.config.fps).toFixed(2)} s at {frameProject.config.fps} FPS</small>}</div>
        <div className="chroma-field chroma-output-size"><label htmlFor="chroma-export-format">Export format</label><select id="chroma-export-format" value={exportFormat} onChange={event => setExportFormat(event.target.value as 'webp' | 'png' | 'atlas')}><option value="webp">Animated WebP</option><option value="png">Individual PNG frames</option><option value="atlas">PNG atlas</option></select></div>
        {exportFormat === 'atlas' && <div className="chroma-field"><label htmlFor="chroma-atlas-rows">Atlas rows</label><input id="chroma-atlas-rows" type="number" min="1" max={exportFrameCount || undefined} value={effectiveAtlasRows} onChange={event => setAtlasRows(Math.max(1, Math.min(exportFrameCount ?? Number.MAX_SAFE_INTEGER, Number(event.target.value) || 1)))}/>{exportFrameCount && <small>{effectiveAtlasRows} rows × {Math.ceil(exportFrameCount / effectiveAtlasRows)} columns</small>}</div>}
        <button className="chroma-convert" disabled={(!active && !frameProject) || (exportOrder === 'edited' && !frameProject) || frameSettingsChanged || running || directoryOpen || !outputDirectory || (!frameProject && !customSizeValid)} onClick={exportCurrent}>{running ? <><RefreshCw size={17} className="chroma-spin"/> Exporting…</> : <><Play size={17} fill="currentColor"/> Export</>}</button>
        <p className="chroma-note">{exportFormat === 'png' ? 'PNG frames are saved in a new folder.' : exportFormat === 'atlas' ? 'Unused atlas cells remain transparent.' : 'Animated WebP loops at the selected output FPS.'} Checkerboard and preview background are not exported.</p>
        {recentOutput && <div className="chroma-result"><Check size={17}/><div className="chroma-result-details"><b>Latest transparent animation</b><span>{saveStatus || (recentOutput.savedPath ? `Saved: ${recentOutput.savedPath}` : 'Conversion complete; click to save')}</span></div><span className="checker"><img src={recentOutput.url} alt="Converted Animated WebP"/></span><button onClick={openOutputFolder}><FolderOpen size={15}/> {recentOutput.savedPath ? 'Open folder' : 'Save locally'}</button><button className="chroma-result-close" onClick={dismissRecentOutput} aria-label="Dismiss result" title="Dismiss result"><X size={16}/></button></div>}
        </div>}
      </section>
      </div>
    </div>
    {saveStatus && <div className={`chroma-save-toast ${saveStatus.startsWith('Saved:') ? 'success' : ''}`} role="status" title={saveStatus}>
      {saveStatus.startsWith('Saved:') ? <Check size={16}/> : running ? <RefreshCw size={16} className="chroma-spin"/> : null}
      <span>{saveStatus.startsWith('Saved:') ? `Saved: ${saveStatus.slice(6).trim().split(/[\\/]/).pop()}` : saveStatus}</span>
      <button type="button" aria-label="Dismiss notification" onClick={() => setSaveStatus('')}><X size={14}/></button>
    </div>}
    <FrameEditor projectId={activeProjectId} sourceRevision={sourceRevision} config={{ ...settings, startFrame: effectiveStartFrame, endFrame: effectiveEndFrame, sourceFps, frameTimingVersion }} disabled={running || !customSizeValid || !duration} editable={previewOrder === 'edited'} needsRegeneration={frameSettingsChanged || legacyFrameTiming} settingsChanged={frameSettingsChanged} legacyFrameTiming={legacyFrameTiming} previewSeek={editedPreviewSeek} playing={editedPlaying} globalMaskUrl={outputMask.previewUrl} backgroundUrl={backgroundUrl} backgroundOriginalSize={backgroundOriginalSize} onPlayingChange={setEditedPlaying} onRestoreGeneratedSettings={restoreGeneratedSettings} onPreview={receiveFramePreview} onProjectChange={receiveFrameProject} onPendingSave={receivePendingFrameSave}/>
  </main>;
}
