import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Crop, Film, FolderOpen, Pause, Play, Plus, RefreshCw, RotateCcw, Settings2, SkipBack, SkipForward, Trash2, Upload, X } from 'lucide-react';
import './chroma.css';

type Settings = { color: string; similarity: number; blend: number; fps: number; size: string; width: number; height: number; squareMode: 'crop' | 'pad'; cropScale: number; cropX: number; cropY: number; foregroundZoom: number; foregroundX: number; foregroundY: number };
type FileProfile = { settings: Settings; sourceFps: number; frame: number; outputFrame: number | null; widthDraft: string; heightDraft: string; outputDirectory: string; backgroundUrl: string; backgroundName: string };
type FrameRange = { start: number; end: number | null };
type FileState = { status: string; progress: number; error?: string };
type RecentOutput = { blob: Blob; url: string; name: string; savedPath: string };
type PreviewCache = { file: File; signature: string; url: string };
const defaults: Settings = { color: '#00FF00', similarity: 0.27, blend: 0.08, fps: 20, size: 'original', width: 512, height: 512, squareMode: 'crop', cropScale: 1, cropX: 0.5, cropY: 0.5, foregroundZoom: 1, foregroundX: 0, foregroundY: 0 };
const newProfile = (directory = ''): FileProfile => ({ settings: { ...defaults }, sourceFps: 30, frame: 15, outputFrame: null, widthDraft: '512', heightDraft: '512', outputDirectory: directory, backgroundUrl: '', backgroundName: '' });
const api = '/api/chroma';

async function errorFrom(response: Response) {
  const data = await response.json().catch(() => ({}));
  return new Error(data.error || `Request failed: HTTP ${response.status}`);
}

function fileKey(file: File, index: number) { return `${index}:${file.name}:${file.size}:${file.lastModified}`; }
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

export default function ChromaPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [selected, setSelected] = useState(0);
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
  const [foregroundEditing, setForegroundEditing] = useState(false);
  const [foregroundDragging, setForegroundDragging] = useState(false);
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
  const [running, setRunning] = useState(false);
  const [defaultDirectory, setDefaultDirectory] = useState('');
  const [directoryDraft, setDirectoryDraft] = useState('');
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directoryError, setDirectoryError] = useState('');
  const [folderError, setFolderError] = useState('');
  const [directoryPicking, setDirectoryPicking] = useState(false);
  const [recentOutput, setRecentOutput] = useState<RecentOutput | null>(null);
  const [saveStatus, setSaveStatus] = useState('');
  const [dragging, setDragging] = useState(false);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [settingsCollapsed, setSettingsCollapsed] = useState(false);
  const [settingsPanelWidth, setSettingsPanelWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem('chroma-settings-panel-width'));
    return Number.isFinite(saved) && saved >= 280 && saved <= 760 ? Math.round(saved) : 380;
  });
  const [settingsResizing, setSettingsResizing] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  const settingsResizeRef = useRef<{ cleanup: () => void } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const outputVideoRef = useRef<HTMLVideoElement>(null);
  const playbackVideoRef = useRef<HTMLVideoElement>(null);
  const outputRequestedFrame = useRef<number | null>(null);
  const outputCaptureSequence = useRef(0);
  const frameBlob = useRef<Blob | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const backgroundInput = useRef<HTMLInputElement>(null);
  const backgroundUrls = useRef<Set<string>>(new Set());
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
  const active = files[selected];
  const profile = active ? profiles.get(active) || newProfile(defaultDirectory) : idleProfile;
  const settings = profile.settings;
  const sourceFps = profile.sourceFps;
  const frame = profile.frame;
  const outputFrame = profile.outputFrame;
  const customWidthDraft = profile.widthDraft;
  const customHeightDraft = profile.heightDraft;
  const outputDirectory = profile.outputDirectory || defaultDirectory;
  const outputLabel = outputDirectory || 'Loading output folder…';
  const backgroundUrl = profile.backgroundUrl;
  const backgroundName = profile.backgroundName;
  const activeRange = (active && ranges.get(active)) || { start: 1, end: null };
  const maxFrame = Math.max(1, Math.floor(duration * sourceFps));
  const effectiveStartFrame = Math.min(activeRange.start, maxFrame);
  const effectiveEndFrame = activeRange.end === null ? maxFrame : Math.max(effectiveStartFrame, Math.min(activeRange.end, maxFrame));
  const effectiveOutputFrame = Math.max(effectiveStartFrame, Math.min(effectiveEndFrame, outputFrame ?? frame));
  const previewSignature = JSON.stringify([settings.color, settings.similarity, settings.blend, settings.fps, settings.size, settings.width, settings.height, settings.squareMode, settings.cropScale, settings.cropX, settings.cropY, effectiveStartFrame, effectiveEndFrame, sourceFps]);
  const hasCachedPreview = !!active && previewCache?.file === active && previewCache.signature === previewSignature;

  useEffect(() => { window.localStorage.setItem('chroma-settings-panel-width', String(settingsPanelWidth)); }, [settingsPanelWidth]);
  useEffect(() => () => settingsResizeRef.current?.cleanup(), []);
  useEffect(() => {
    const clampWidth = () => {
      if (window.innerWidth > 1100) setSettingsPanelWidth(current => Math.min(current, maxSettingsPanelWidth()));
    };
    clampWidth();
    const observer = new ResizeObserver(clampWidth);
    if (layoutRef.current) observer.observe(layoutRef.current);
    return () => observer.disconnect();
  }, [filesCollapsed]);

  function maxSettingsPanelWidth() {
    const layoutWidth = layoutRef.current?.getBoundingClientRect().width || window.innerWidth;
    const roomForPreviews = filesCollapsed ? layoutWidth - 54 - 32 - 440 : layoutWidth - 32 - 440 * 1.65;
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

  function updateProfile(update: (current: FileProfile) => FileProfile) {
    if (active) setProfiles(current => { const next = new Map<File, FileProfile>(current); next.set(active, update(next.get(active) || newProfile(defaultDirectory))); return next; });
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
    setForegroundEditing(false);
    setForegroundDragging(false);
    foregroundDrag.current = null;
    setCropDraft(null);
    cropDraftRef.current = null;
    cropDrag.current = null;
    setDirectoryOpen(false);
    setDirectoryDraft(active ? profiles.get(active)?.outputDirectory || defaultDirectory : idleProfile.outputDirectory || defaultDirectory);
    if (!active) { setSourceUrl(''); return; }
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
  }, [active]);

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

  useEffect(() => () => { for (const url of backgroundUrls.current) URL.revokeObjectURL(url); }, []);

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
    if (!active) return;
    const start = Math.max(1, Math.min(effectiveEndFrame, Math.round(value) || 1));
    setRanges(current => {
      const old = current.get(active) || { start: 1, end: null };
      const next = new Map(current);
      next.set(active, { start, end: old.end });
      return next;
    });
  }

  function setRangeEnd(value: number) {
    if (!active) return;
    const end = Math.max(activeRange.start, Math.min(maxFrame, Math.round(value) || activeRange.start));
    setRanges(current => {
      const next = new Map(current);
      next.set(active, { start: current.get(active)?.start || 1, end });
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
    if (!foregroundEditing || !active) return;
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

  function addFiles(list: FileList | File[]) {
    if (running) return;
    const mp4s = Array.from(list).filter(file => /\.mp4$/i.test(file.name));
    if (!mp4s.length) { setPreviewStatus('Select an MP4 file.'); return; }
    setProfiles(current => { const next = new Map(current); mp4s.forEach((file, index) => next.set(file, files.length === 0 && index === 0 ? { ...idleProfile, settings: { ...idleProfile.settings }, outputDirectory: idleProfile.outputDirectory || defaultDirectory } : newProfile(idleProfile.outputDirectory || defaultDirectory))); return next; });
    setFiles(current => [...current, ...mp4s]);
    if (!files.length) setSelected(0);
  }

  function updateBackground(file: File) {
    if (!active || !file.type.startsWith('image/')) return;
    if (backgroundUrl) { URL.revokeObjectURL(backgroundUrl); backgroundUrls.current.delete(backgroundUrl); }
    const url = URL.createObjectURL(file);
    backgroundUrls.current.add(url);
    updateProfile(current => ({ ...current, backgroundUrl: url, backgroundName: file.name }));
  }

  function clearBackground() {
    if (backgroundUrl) { URL.revokeObjectURL(backgroundUrl); backgroundUrls.current.delete(backgroundUrl); }
    updateProfile(current => ({ ...current, backgroundUrl: '', backgroundName: '' }));
  }

  function removeFile(index: number) {
    if (running) return;
    const file = files[index];
    const url = profiles.get(file)?.backgroundUrl;
    if (url) { URL.revokeObjectURL(url); backgroundUrls.current.delete(url); }
    setFiles(current => current.filter((_, item) => item !== index));
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

  async function convertCurrent() {
    if (!active || running || !outputDirectory || directoryOpen || !customSizeValid) return;
    setRunning(true);
    try { await convertOne(active, selected); }
    finally { setRunning(false); }
  }

  const currentFrame = Math.min(frame, maxFrame);
  const framePercent = (currentFrame - 1) / Math.max(1, maxFrame - 1) * 100;
  const startPercent = (effectiveStartFrame - 1) / Math.max(1, maxFrame - 1) * 100;
  const endPercent = (effectiveEndFrame - 1) / Math.max(1, maxFrame - 1) * 100;
  const effectiveEndForConfig = activeRange.end === null ? null : effectiveEndFrame;
  const customSizeValid = settings.size !== 'custom' || [customWidthDraft, customHeightDraft].every(value => /^\d+$/.test(value) && Number(value) >= 16 && Number(value) <= 4096);
  const outputWidth = settings.size === 'original' ? videoSize.width : settings.size === 'custom' ? settings.width : Number(settings.size);
  const outputHeight = settings.size === 'original' ? videoSize.height : settings.size === 'custom' ? settings.height : Number(settings.size);
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
  const foregroundStyle: React.CSSProperties = { transform: `translate(${settings.foregroundX * 100}%, ${settings.foregroundY * 100}%) scale(${settings.foregroundZoom})` };

  return <main className="chroma-page">
    <header className="chroma-module-header">
      <div className="chroma-module-brand"><span className="chroma-module-mark"><Film size={17}/></span><strong>MP4 BG <span>Removal</span></strong><span className="chroma-module-subtitle">Green screen · Animated WebP</span></div>
      <div className="chroma-local"><i/>Fully local processing</div>
    </header>
    <div ref={layoutRef} className={`chroma-layout ${filesCollapsed ? 'files-collapsed' : ''} ${settingsCollapsed ? 'settings-collapsed' : ''}`} style={{ '--chroma-settings-width': `${settingsPanelWidth}px` } as React.CSSProperties}>
      <section className={`chroma-panel chroma-files ${filesCollapsed ? 'collapsed' : ''}`}>
        <div className="chroma-panel-title"><span>01 / Files</span><strong>{files.length} MP4 files</strong><button className="chroma-panel-toggle" type="button" aria-label={filesCollapsed ? 'Expand file list' : 'Collapse file list'} title={filesCollapsed ? 'Expand file list' : 'Collapse file list'} onClick={() => setFilesCollapsed(value => !value)}>{filesCollapsed ? <ChevronRight size={16}/> : <ChevronLeft size={16}/>}</button></div>
        <div className={`chroma-drop ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!running) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!running) addFiles(event.dataTransfer.files); }} onClick={() => { if (!running) fileInput.current?.click(); }} role="button" tabIndex={running ? -1 : 0} aria-disabled={running} onKeyDown={event => { if (event.key === 'Enter' && !running) fileInput.current?.click(); }}>
          <Upload size={27}/><b>Drop MP4 files here</b><span>or click to choose files</span>
        </div>
        <input ref={fileInput} type="file" accept="video/mp4,.mp4" multiple hidden onChange={event => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }}/>
        <div className="chroma-list">{files.map((file, index) => { const state = states[fileKey(file, index)]; return <div key={fileKey(file, index)} className={`chroma-file ${selected === index ? 'selected' : ''}`} onClick={() => { if (!running) setSelected(index); }}>
          <Film size={17}/><div className="chroma-file-name"><b title={file.name}>{file.name}</b><span>{(file.size / 1024 / 1024).toFixed(1)} MB · {state?.status || 'Ready'}</span>{state?.error && <em title={state.error}>{state.error}</em>}{state && state.progress > 0 && state.progress < 100 && <i style={{ width: `${state.progress}%` }}/>}</div>
          {!running && <button title="Remove" onClick={event => { event.stopPropagation(); removeFile(index); }}><Trash2 size={15}/></button>}
        </div>; })}</div>
        {files.length > 0 && <button className="chroma-add" disabled={running} onClick={() => fileInput.current?.click()}><Plus size={16}/> Add more videos</button>}
      </section>
      <section className="chroma-panel chroma-preview-panel">
        <div className="chroma-panel-title"><span>02 / Live frame preview</span><strong>{videoSize.width ? `${videoSize.width} × ${videoSize.height}` : active?.name || 'No file selected'}</strong></div>
        <div className="chroma-crop-toolbar"><div className="chroma-fit-picker"><label htmlFor="chroma-fit-mode">Frame fitting</label><select id="chroma-fit-mode" value={settings.size === 'original' ? 'original' : settings.squareMode} onChange={event => applyFitMode(event.target.value as 'original' | Settings['squareMode'])}><option value="original">Keep original size</option><option value="crop">Crop to output ratio</option><option value="pad">Scale to fit + transparent padding</option></select></div>{croppedSource && <div className="chroma-crop-dimensions">Crop area <b>{cropWidth} × {cropHeight}</b></div>}</div>
        <div className="chroma-preview-grid">
          <div>
            <div className="chroma-preview-label">{cropEditing ? 'Source · drag inside the white frame' : croppedSource ? 'Cropped source' : 'Source frame'}</div>
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
          <div>
            <div className="chroma-preview-label">Output · background is preview-only</div>
            <video ref={outputVideoRef} src={sourceUrl || undefined} preload="auto" muted playsInline hidden onLoadedMetadata={seekOutputVideo} onLoadedData={captureOutputFrame} onSeeked={captureOutputFrame}/>
            <div className={`chroma-stage chroma-output-stage checker ${foregroundEditing ? 'editing' : ''} ${foregroundDragging ? 'dragging' : ''}`} style={outputWidth && outputHeight ? { aspectRatio: `${outputWidth} / ${outputHeight}` } : undefined}>
              {backgroundUrl && <img className="chroma-preview-background" src={backgroundUrl} alt="Custom preview background"/>}
              {hasCachedPreview ? <video ref={playbackVideoRef} className="chroma-output-video" src={previewCache.url} style={foregroundStyle} muted playsInline loop preload="auto" aria-label="Cached transparent interval preview" onTimeUpdate={event => { if (animationPlaying) setOutputFrame(Math.max(effectiveStartFrame, Math.min(effectiveEndFrame, effectiveStartFrame + Math.round(event.currentTarget.currentTime * sourceFps)))); }}/>: previewUrl ? <img className="chroma-output-image" src={previewUrl} style={foregroundStyle} alt="Transparent keyed and cropped preview"/> : <span>{previewStatus}</span>}
              {foregroundEditing && <div className="chroma-foreground-drag-layer" role="button" tabIndex={0} aria-label="Drag transparent foreground" onPointerDown={onForegroundPointerDown} onPointerMove={onForegroundPointerMove} onPointerUp={onForegroundPointerEnd} onPointerCancel={onForegroundPointerEnd} onKeyDown={event => { const step = event.shiftKey ? 0.05 : 0.01; const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0; const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0; if (!dx && !dy) return; event.preventDefault(); setSettings(current => ({ ...current, foregroundX: Math.max(-1, Math.min(1, current.foregroundX + dx)), foregroundY: Math.max(-1, Math.min(1, current.foregroundY + dy)) })); }}/>} 
            </div>
            <div className="chroma-output-scrubber"><div><label htmlFor="chroma-output-frame">Output frame preview{hasCachedPreview ? ' · Cached' : ''}</label><b>#{effectiveOutputFrame}</b>{outputFrame !== null && <button type="button" onClick={() => { stopPlayback(); outputRequestedFrame.current = null; setOutputFrameCapture(null); setOutputFrame(null); }}>Follow source frame</button>}</div><input id="chroma-output-frame" aria-label="Output frame preview" type="range" min={effectiveStartFrame} max={effectiveEndFrame} step="1" value={effectiveOutputFrame} disabled={!active || !duration || effectiveStartFrame === effectiveEndFrame} onChange={event => previewOutputFrame(Number(event.target.value))}/></div>
            <div className="chroma-playback-controls">
              <button disabled={!active || !duration || !customSizeValid} title={hasCachedPreview ? 'Play the cached transparent interval' : 'Generate and play the transparent interval'} onClick={previewRendering || animationPlaying ? () => stopPlayback() : playSelectedRange}>{previewRendering ? <RefreshCw size={14} className="chroma-spin"/> : animationPlaying ? <Pause size={14}/> : <Play size={14}/>} {previewRendering ? 'Stop generation' : animationPlaying ? 'Pause playback' : 'Play preview'}</button>
              <button disabled={!active} onClick={() => backgroundInput.current?.click()}><Upload size={14}/> {backgroundName ? 'Change background' : 'Upload background'}</button>
              {backgroundUrl && <button className="chroma-background-remove" onClick={clearBackground} title="Restore checkerboard"><X size={14}/></button>}
              <button className={`chroma-foreground-settings ${foregroundEditing ? 'active' : ''}`} disabled={!active} onClick={() => { foregroundDrag.current = null; setForegroundDragging(false); setForegroundEditing(current => !current); }} title={foregroundEditing ? 'Finish foreground adjustment' : 'Adjust transparent foreground'}><Settings2 size={14}/> {foregroundEditing ? 'Done' : 'Adjust'}</button>
              <input ref={backgroundInput} type="file" accept="image/*" hidden onChange={event => { const file = event.target.files?.[0]; if (file) updateBackground(file); event.target.value = ''; }}/>
            </div>
            {foregroundEditing && <div className="chroma-foreground-controls"><label htmlFor="chroma-foreground-zoom">Foreground zoom <b>{settings.foregroundZoom.toFixed(2)}×</b></label><input id="chroma-foreground-zoom" type="range" min="0.5" max="2" step="0.01" value={settings.foregroundZoom} onChange={event => setSettings(current => ({ ...current, foregroundZoom: Number(event.target.value) }))}/><div><span>Drag to reposition the foreground; the background stays fixed.</span><button onClick={() => setSettings(current => ({ ...current, foregroundZoom: 1, foregroundX: 0, foregroundY: 0 }))}><RotateCcw size={13}/> Reset</button></div></div>}
            <div className="chroma-playback-status" role="status">{playbackStatus || (backgroundName ? `Preview background: ${backgroundName}` : 'The preview background is not exported')}{previewRendering && <i style={{ width: `${playbackProgress}%` }}/>}</div>
          </div>
        </div>
        <div className="chroma-preview-status"><RefreshCw size={13}/>{previewStatus}</div>
      </section>
      <section className={`chroma-panel chroma-settings ${settingsCollapsed ? 'collapsed' : ''}`}>
        {!settingsCollapsed && <div className={`chroma-settings-resize ${settingsResizing ? 'dragging' : ''}`} role="separator" tabIndex={0} aria-label="Resize settings panel" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={760} aria-valuenow={settingsPanelWidth} title="Drag to resize the settings panel" onPointerDown={onSettingsResizeStart} onKeyDown={onSettingsResizeKey}/>}
        <div className="chroma-panel-title"><span>03 / Keying and export</span><button className="chroma-panel-toggle" type="button" aria-label={settingsCollapsed ? 'Expand settings panel' : 'Collapse settings panel'} title={settingsCollapsed ? 'Expand settings panel' : 'Collapse settings panel'} onClick={() => setSettingsCollapsed(value => !value)}>{settingsCollapsed ? <ChevronLeft size={16}/> : <ChevronRight size={16}/>}</button></div>
        <div className="chroma-field"><label>Chroma key color</label><div className="chroma-color"><input type="color" value={settings.color} onChange={event => setSettings({ ...settings, color: event.target.value.toUpperCase() })}/><code>{settings.color}</code></div></div>
        <div className="chroma-field"><label>Similarity <b>{settings.similarity.toFixed(2)}</b></label><input type="range" min="0.01" max="1" step="0.01" value={settings.similarity} onChange={event => setSettings({ ...settings, similarity: Number(event.target.value) })}/><small>Higher values remove more similar green</small></div>
        <div className="chroma-field"><label>Blend / Feather <b>{settings.blend.toFixed(2)}</b></label><input type="range" min="0" max="1" step="0.01" value={settings.blend} onChange={event => setSettings({ ...settings, blend: Number(event.target.value) })}/><small>Softens the transparency transition at edges</small></div>
        <div className="chroma-settings-row"><div className="chroma-field"><label>Source FPS</label><input type="number" min="1" max="120" value={sourceFps} onChange={event => setSourceFps(Math.max(1, Math.min(120, Number(event.target.value) || 1)))}/></div><div className="chroma-field"><label>Output FPS</label><input type="number" min="1" max="60" value={settings.fps} onChange={event => setSettings({ ...settings, fps: Math.max(1, Math.min(60, Number(event.target.value) || 1)) })}/></div></div>
        <div className="chroma-field chroma-output-size"><label>Output size</label><select value={settings.size} onChange={event => setSettings({ ...settings, size: event.target.value })}><option value="original">Keep original size</option><option value="256">256 × 256</option><option value="512">512 × 512</option><option value="1024">1024 × 1024</option><option value="custom">Custom dimensions…</option></select></div>
        {settings.size === 'custom' && <div className="chroma-custom-size"><label>Width <input aria-label="Custom width" type="number" min="16" max="4096" value={customWidthDraft} onChange={event => updateCustomDimension('width', event.target.value)} onBlur={() => normalizeCustomDimension('width')}/></label><span>×</span><label>Height <input aria-label="Custom height" type="number" min="16" max="4096" value={customHeightDraft} onChange={event => updateCustomDimension('height', event.target.value)} onBlur={() => normalizeCustomDimension('height')}/></label>{!customSizeValid && <small>Enter integer dimensions from 16 to 4096.</small>}</div>}
        <div className="chroma-field"><label>Output folder</label><button className="chroma-folder" onClick={chooseFolder} title="Choose output folder" disabled={running}><FolderOpen size={16}/><span>{outputLabel}</span></button>{directoryOpen && <div className="chroma-directory-editor"><label htmlFor="chroma-directory-path">Full path to a local folder</label><input id="chroma-directory-path" value={directoryDraft} onChange={event => setDirectoryDraft(event.target.value)} placeholder="For example C:\\Users\\Administrator\\Pictures"/><div><button onClick={pickFolderNative} disabled={directoryPicking}>{directoryPicking ? 'Waiting for folder selection…' : 'Browse folders'}</button><button onClick={applyDirectory} disabled={directoryPicking}>Use this folder</button><button onClick={() => { setDirectoryDraft(defaultDirectory); setDirectoryError(''); }} disabled={directoryPicking}>Use default path</button></div>{directoryError && <em>{directoryError}</em>}</div>}<button className="chroma-open-folder" onClick={openSelectedFolder} disabled={!outputDirectory}><FolderOpen size={15}/> Open folder</button>{folderError && <small className="chroma-folder-error">{folderError}</small>}</div>
        <button className="chroma-convert" disabled={!active || running || directoryOpen || !outputDirectory || !customSizeValid} onClick={convertCurrent}>{running ? <><RefreshCw size={17} className="chroma-spin"/> Converting current file</> : <><Play size={17} fill="currentColor"/> Convert current file</>}</button>
        <p className="chroma-note">Exports a looping Animated WebP. Checkerboard is preview-only; the source MP4 is untouched.</p>
      </section>
    </div>
    {recentOutput && <div className="chroma-result"><Check size={17}/><div className="chroma-result-details"><b>Latest transparent animation</b><span>{saveStatus || (recentOutput.savedPath ? `Saved: ${recentOutput.savedPath}` : 'Conversion complete; click to save')}</span></div><span className="checker"><img src={recentOutput.url} alt="Converted Animated WebP"/></span><button onClick={openOutputFolder}><FolderOpen size={15}/> {recentOutput.savedPath ? 'Open folder' : 'Save locally'}</button><button className="chroma-result-close" onClick={dismissRecentOutput} aria-label="Dismiss result" title="Dismiss result"><X size={16}/></button></div>}
  </main>;
}
