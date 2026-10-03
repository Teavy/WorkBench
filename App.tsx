import React, { useEffect, useState, useRef } from 'react';
import { CameraState, ContentCategory, ControlMode, AppStatus, HistoryItem } from './types';
import CameraOrbit from './components/CameraOrbit';
import Slider from './components/Slider';
import { constructAutoBrief, constructPrompts } from './services/viewPrompt';
import { Upload, Download, RefreshCw, Wand2, Image as ImageIcon, Sparkles, AlertCircle, Copy, Check, History, X, Trash2, FolderOpen, Sliders } from 'lucide-react';

const App: React.FC = () => {
  // State
  const [inputImage, setInputImage] = useState<string | null>(null);
  const [outputImage, setOutputImage] = useState<string | null>(null);
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [jobId, setJobId] = useState<string | null>(null);
  
  // History State
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const [sourceCamera, setSourceCamera] = useState<CameraState>({
    azimuth: 0,
    elevation: 0,
    distance: 1.0,
  });
  const [camera, setCamera] = useState<CameraState>({
    azimuth: -30,
    elevation: 17,
    distance: 1.0,
  });
  const [category, setCategory] = useState<ContentCategory>('character');
  const [controlMode, setControlMode] = useState<ControlMode>('manual');
  const [autoCamera, setAutoCamera] = useState<CameraState>({ azimuth: 0, elevation: 0, distance: 1 });

  const [copiedState, setCopiedState] = useState<'en' | 'zh' | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Derived State
  const prompts = constructPrompts(sourceCamera, camera, category);
  const autoBrief = constructAutoBrief(autoCamera, category);
  const activeCamera = controlMode === 'auto' ? autoCamera : camera;
  const setActiveCamera = controlMode === 'auto' ? setAutoCamera : setCamera;

  useEffect(() => {
    if (!jobId || status !== AppStatus.QUEUED) return;
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Could not check the local job. Is the development server running?');
        const job = await response.json();
        if (active && job.status === 'complete') {
          const url = `/api/jobs/${jobId}/output`;
          setOutputImage(url);
          setHistory(prev => [{ id: jobId, url, timestamp: Date.now() }, ...prev]);
          setStatus(AppStatus.SUCCESS);
        }
      } catch (error) {
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : 'Could not check the local job.');
          setStatus(AppStatus.ERROR);
        }
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [jobId, status]);

  // Handlers
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      try {
        const file = e.target.files[0];
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
          throw new Error('Please choose a PNG, JPEG, or WebP image.');
        }
        const dataUri = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error('Could not read the image.'));
          reader.readAsDataURL(file);
        });
        setInputImage(dataUri);
        setOutputImage(null);
        setJobId(null);
        setStatus(AppStatus.IDLE);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load image.');
        setStatus(AppStatus.ERROR);
      }
    }
  };

  const handleGenerate = async () => {
    if (!inputImage) return;
    
    setStatus(AppStatus.UPLOADING);
    setErrorMessage('');
    
    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: inputImage,
          mode: controlMode,
          sourceCamera: controlMode === 'manual' ? sourceCamera : undefined,
          camera: activeCamera,
          category,
          prompt: controlMode === 'manual' ? prompts.en : autoBrief.en,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save the local job.');
      setJobId(result.id);
      setOutputImage(null);
      setStatus(AppStatus.QUEUED);
    } catch (err: any) {
      setStatus(AppStatus.ERROR);
      setErrorMessage(err.message || "Failed to generate image.");
    }
  };

  const downloadImage = (url: string, filename?: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || `codex-view-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  
  const downloadAllHistory = () => {
    // Sequentially download to avoid browser blocking multiple popups
    history.forEach((item, index) => {
      setTimeout(() => {
        downloadImage(item.url, `history-${index}-${item.id.slice(0,4)}.png`);
      }, index * 500);
    });
  };

  const handleCopy = (text: string, lang: 'en' | 'zh') => {
    navigator.clipboard.writeText(text);
    setCopiedState(lang);
    setTimeout(() => setCopiedState(null), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500/30 relative">
      {/* Header */}
      <header className="h-[58px] flex items-center justify-between gap-4 px-4 md:px-8 border-b border-[#242532] bg-[#0c0d15]">
        <div className="flex items-center gap-3 min-w-0">
          <span className="grid place-items-center shrink-0 w-[33px] h-[33px] rounded-[10px] text-white bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-900/40">
            <Sparkles className="w-[17px] h-[17px]" />
          </span>
          <h1 className="text-lg font-extrabold tracking-tight whitespace-nowrap">
            View <span className="gradient-text">Synthesizer</span>
          </h1>
          <span className="hidden sm:inline-flex items-center rounded-full border border-[#2a2d39] bg-[#171922] px-4 py-2 text-xs text-slate-400 whitespace-nowrap">
            Image perspective editor
          </span>
        </div>
        <div className="hidden sm:flex items-center gap-2 rounded-full border border-[#30313e] bg-[#181a23] px-3 py-2 text-[11px] text-slate-300 whitespace-nowrap">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          Local jobs · Codex image generation
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-6 lg:p-8 relative z-0">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* TOP ROW LEFT: Input & Output (Visuals) */}
          <div className="lg:col-span-8 flex flex-col gap-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-[500px]">
              
              {/* Input Card */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl flex flex-col overflow-hidden shadow-xl relative group">
                <div className="p-3 border-b border-slate-800 flex justify-between items-center bg-slate-900/80">
                  <span className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                    <ImageIcon className="w-4 h-4 text-indigo-400" /> Input Image
                  </span>
                  {inputImage && (
                    <button 
                      onClick={() => setInputImage(null)}
                      className="text-xs text-red-400 hover:text-red-300 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
                
                <div className="flex-1 min-h-0 relative flex items-center justify-center bg-slate-950/50">
                  {inputImage ? (
                    <img 
                      src={inputImage} 
                      alt="Input" 
                      className="absolute inset-0 w-full h-full object-contain p-2"
                    />
                  ) : (
                    <div 
                      onClick={() => fileInputRef.current?.click()}
                      className="flex flex-col items-center gap-4 cursor-pointer p-8 rounded-lg border-2 border-dashed border-slate-700 hover:border-indigo-500 hover:bg-slate-800/30 transition-all group/upload"
                    >
                      <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center group-hover/upload:scale-110 transition-transform">
                        <Upload className="w-8 h-8 text-slate-400 group-hover/upload:text-indigo-400" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-medium text-slate-300">Click to upload image</p>
                        <p className="text-xs text-slate-500 mt-1">PNG, JPG</p>
                      </div>
                    </div>
                  )}
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    onChange={handleFileChange} 
                    accept="image/*" 
                    className="hidden" 
                  />
                </div>
              </div>

              {/* Output Card */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl flex flex-col overflow-hidden shadow-xl relative">
                <div className="p-3 border-b border-slate-800 flex justify-between items-center bg-slate-900/80">
                  <span className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                    <Wand2 className="w-4 h-4 text-purple-400" /> Output Image
                  </span>
                  {outputImage && (
                    <button 
                      onClick={() => downloadImage(outputImage)}
                      className="text-slate-400 hover:text-white transition-colors"
                      title="Download"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                  )}
                </div>
                
                <div className="flex-1 min-h-0 relative flex items-center justify-center bg-slate-950/50">
                  {status === AppStatus.UPLOADING || status === AppStatus.QUEUED ? (
                    <div className="flex flex-col items-center gap-3 animate-pulse">
                      <div className="w-12 h-12 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></div>
                      <p className="text-sm text-indigo-400 font-medium">
                        {status === AppStatus.UPLOADING ? 'Saving local job...' : 'Waiting for Codex result...'}
                      </p>
                    </div>
                  ) : outputImage ? (
                    <img 
                      src={outputImage} 
                      alt="Output" 
                      className="absolute inset-0 w-full h-full object-contain p-2"
                    />
                  ) : (
                    <div className="text-slate-600 text-sm flex flex-col items-center gap-2">
                       <div className="w-12 h-12 rounded-full bg-slate-800/50 flex items-center justify-center">
                         <ImageIcon className="w-6 h-6 text-slate-700" />
                       </div>
                       <span>Generated result will appear here</span>
                    </div>
                  )}
                  
                  {status === AppStatus.ERROR && (
                    <div className="absolute inset-0 bg-slate-900/90 flex flex-col items-center justify-center p-6 text-center z-10">
                      <AlertCircle className="w-10 h-10 text-red-500 mb-2" />
                      <p className="text-red-400 font-medium">Generation Failed</p>
                      <p className="text-xs text-slate-400 mt-2 max-w-xs whitespace-pre-wrap">{errorMessage}</p>
                      <button 
                        onClick={() => setStatus(AppStatus.IDLE)}
                        className="mt-4 px-4 py-2 bg-slate-800 rounded-md text-xs hover:bg-slate-700 transition-colors"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* TOP ROW RIGHT: Settings & Action */}
          <div className="lg:col-span-4 flex flex-col gap-6">
            
            {/* History Entry Card */}
            <button 
              onClick={() => setIsHistoryOpen(true)}
              className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-md flex items-center justify-between hover:border-indigo-500/50 transition-all group"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center group-hover:bg-slate-700 transition-colors">
                  <History className="w-5 h-5 text-indigo-400" />
                </div>
                <div className="text-left">
                  <div className="text-sm font-bold text-slate-200">History</div>
                  <div className="text-xs text-slate-500">{history.length} generated images</div>
                </div>
              </div>
              <div className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-800 group-hover:bg-indigo-600 transition-colors">
                <FolderOpen className="w-4 h-4 text-slate-400 group-hover:text-white" />
              </div>
            </button>

            {/* Main Action Button */}
            <button
              onClick={handleGenerate}
              disabled={!inputImage || status === AppStatus.UPLOADING || status === AppStatus.QUEUED}
              className={`
                w-full py-4 rounded-xl font-bold text-lg shadow-lg transition-all transform
                flex items-center justify-center gap-2
                ${!inputImage 
                   ? 'bg-slate-800 text-slate-500 cursor-not-allowed' 
                   : status === AppStatus.UPLOADING || status === AppStatus.QUEUED
                     ? 'bg-indigo-900 text-indigo-200 cursor-wait opacity-80'
                     : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white hover:scale-[1.02] active:scale-[0.98] shadow-indigo-500/20'
                }
              `}
            >
              {status === AppStatus.UPLOADING || status === AppStatus.QUEUED ? (
                <>
                   <RefreshCw className="w-5 h-5 animate-spin" /> Waiting for Codex
                </>
              ) : (
                <>
                   <Sparkles className="w-5 h-5" /> Create Local Job
                </>
              )}
            </button>

            {jobId && status === AppStatus.QUEUED && (
              <div className="bg-indigo-950/50 border border-indigo-700/50 rounded-xl p-4 text-sm text-indigo-100 space-y-2">
                <p className="font-semibold">Ready for Codex</p>
                <p>Return to this Codex chat and run <span className="font-mono">$generate-view</span>.</p>
                <p className="text-xs text-indigo-300 break-all">Job ID: {jobId}</p>
                <p className="text-xs text-slate-400">This page will show the result when Codex finishes.</p>
              </div>
            )}

          </div>

          {/* BOTTOM ROW: Controls & Prompts */}
          <div className="lg:col-span-12">
               <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full">
                  
                  {/* LEFT: Manual source calibration and desired target view */}
                  <div className="lg:col-span-8 bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl flex flex-col gap-6">
                      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
                        <div>
                          <h3 className="text-lg font-bold text-white flex items-center gap-2"><Sliders className="w-5 h-5 text-indigo-400" /> View Setup</h3>
                          <p className="text-xs text-slate-400 mt-1">{controlMode === 'manual' ? 'First match the uploaded view, then choose the final view.' : 'Start from the uploaded image; set only the relative camera change.'}</p>
                        </div>
                        <label className="text-xs text-slate-300 flex items-center gap-2">
                          Content type
                          <select value={category} onChange={(e) => setCategory(e.target.value as ContentCategory)} className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
                            <option value="character">Character / Person</option>
                            <option value="object">Object / Product</option>
                            <option value="building">Building / Exterior</option>
                            <option value="interior">Interior / Scene</option>
                          </select>
                        </label>
                      </div>

                      <div className="inline-flex self-start rounded-lg border border-slate-700 bg-slate-950/50 p-1 gap-1" role="group" aria-label="View control mode">
                        <button type="button" onClick={() => setControlMode('manual')} aria-pressed={controlMode === 'manual'} className={`px-3 py-2 rounded-md text-sm transition-colors ${controlMode === 'manual' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}>Manual calibration</button>
                        <button type="button" onClick={() => setControlMode('auto')} aria-pressed={controlMode === 'auto'} className={`px-3 py-2 rounded-md text-sm transition-colors ${controlMode === 'auto' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}>AI auto-understand</button>
                      </div>

                      <div className={`grid grid-cols-1 ${controlMode === 'manual' ? 'sm:grid-cols-2' : ''} gap-5`}>
                        {controlMode === 'manual' && <div className="space-y-3">
                          <div className="text-sm font-semibold text-slate-200">1 · Uploaded image view</div>
                          <div className="h-[260px]"><CameraOrbit camera={sourceCamera} onChange={setSourceCamera} label="Input view" resetCamera={{ azimuth: 0, elevation: 0, distance: 1 }} /></div>
                          <div className="space-y-4 p-4 bg-slate-950/30 rounded-lg border border-slate-800/50">
                            <Slider label="Input azimuth" value={sourceCamera.azimuth} min={-180} max={180} unit="°" accentColor="accent-emerald-500" onChange={(val) => setSourceCamera({...sourceCamera, azimuth: val})} />
                            <Slider label="Input elevation" value={sourceCamera.elevation} min={-90} max={90} unit="°" accentColor="accent-pink-500" onChange={(val) => setSourceCamera({...sourceCamera, elevation: val})} />
                          </div>
                        </div>}
                        <div className="space-y-3">
                          <div className="text-sm font-semibold text-slate-200">{controlMode === 'manual' ? '2 · Desired final view' : 'Relative camera change from input'}</div>
                          <div className="h-[260px]"><CameraOrbit camera={activeCamera} onChange={setActiveCamera} label={controlMode === 'manual' ? 'Target view' : 'Relative change'} resetCamera={{ azimuth: 0, elevation: 0, distance: 1 }} relative={controlMode === 'auto'} /></div>
                          <div className="space-y-4 p-4 bg-slate-950/30 rounded-lg border border-slate-800/50">
                            <Slider label={controlMode === 'manual' ? 'Target azimuth' : 'Horizontal change'} value={activeCamera.azimuth} min={-180} max={180} unit="°" accentColor="accent-emerald-500" onChange={(val) => setActiveCamera({...activeCamera, azimuth: val})} />
                            <Slider label={controlMode === 'manual' ? 'Target elevation' : 'Elevation change'} value={activeCamera.elevation} min={-90} max={90} unit="°" accentColor="accent-pink-500" onChange={(val) => setActiveCamera({...activeCamera, elevation: val})} />
                            <Slider label={controlMode === 'manual' ? 'Distance' : 'Relative distance (1x = same)'} value={activeCamera.distance} min={0.5} max={2.0} step={0.1} unit="x" onChange={(val) => setActiveCamera({...activeCamera, distance: val})} />
                          </div>
                        </div>
                      </div>
                      <p className="text-xs text-slate-500">{controlMode === 'manual' ? 'Cubes are direction guides, not reconstructed 3D previews. Set both views relative to the same front/reference direction.' : 'The uploaded image is the starting view. Codex will inspect its subjects, pose, gaze, layout, and likely observation center when processing the job; the cube is a relative direction guide.'}</p>
                  </div>

                  {/* RIGHT: Prompts - 4 Cols */}
                   <div className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl flex flex-col h-full">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-md font-bold text-slate-400 flex items-center gap-2">
                               <span className="w-1 h-4 bg-slate-600 rounded-full"></span>
                               Prompt Logic
                            </h3>
                        </div>

                        {controlMode === 'auto' ? (
                          <div className="flex-1 rounded-lg border border-indigo-700/40 bg-indigo-950/30 p-4 space-y-3 text-sm text-indigo-100">
                            <p className="font-semibold">Prompt prepared by Codex after image inspection</p>
                            <p className="text-slate-300">The page saves your content type and relative camera change. When you run $generate-view, Codex reads the image, identifies its subject and spatial relationships, then writes the image-specific edit prompt.</p>
                            <p className="text-xs text-indigo-300">No API key or automatic image analysis runs in the browser. The final prompt is not available yet.</p>
                          </div>
                        ) : <div className="flex flex-col gap-4 flex-1">
                            {/* English Box */}
                            <div className="relative group flex-1">
                                <div className="text-[10px] uppercase text-slate-500 font-bold mb-1 flex justify-between items-center">
                                    <span>English Prompt</span>
                                    <button 
                                        onClick={() => handleCopy(prompts.en, 'en')} 
                                        className={`
                                            flex items-center gap-1 transition-colors
                                            ${copiedState === 'en' ? 'text-emerald-400' : 'text-indigo-400 hover:text-indigo-300'}
                                        `}
                                    >
                                       {copiedState === 'en' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                       <span>{copiedState === 'en' ? 'Copied' : 'Copy'}</span>
                                    </button>
                                </div>
                                <textarea 
                                    readOnly 
                                    value={prompts.en} 
                                    className="w-full h-full min-h-[100px] bg-slate-950/50 border border-slate-800 rounded p-3 text-[10px] text-slate-300 font-mono resize-none focus:outline-none focus:border-indigo-500/50 transition-colors"
                                />
                            </div>

                            {/* Chinese Box */}
                            <div className="relative group flex-1">
                                <div className="text-[10px] uppercase text-slate-500 font-bold mb-1 flex justify-between items-center">
                                    <span>Chinese Prompt</span>
                                    <button 
                                        onClick={() => handleCopy(prompts.zh, 'zh')} 
                                        className={`
                                            flex items-center gap-1 transition-colors
                                            ${copiedState === 'zh' ? 'text-emerald-400' : 'text-indigo-400 hover:text-indigo-300'}
                                        `}
                                    >
                                       {copiedState === 'zh' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                       <span>{copiedState === 'zh' ? 'Copied' : 'Copy'}</span>
                                    </button>
                                </div>
                                <textarea 
                                    readOnly 
                                    value={prompts.zh} 
                                    className="w-full h-full min-h-[100px] bg-slate-950/50 border border-slate-800 rounded p-3 text-[10px] text-slate-300 font-mono resize-none focus:outline-none focus:border-indigo-500/50 transition-colors"
                                />
                            </div>
                        </div>}
                   </div>

               </div>
          </div>

        </div>

        {/* History Modal Overlay */}
        {isHistoryOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
             {/* Backdrop */}
             <div 
                className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" 
                onClick={() => setIsHistoryOpen(false)}
             ></div>
             
             {/* Modal Content */}
             <div className="relative bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl">
                
                {/* Modal Header */}
                <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900 rounded-t-2xl">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400">
                           <History className="w-5 h-5" />
                        </div>
                        <div>
                           <h2 className="text-lg font-bold text-white">Generation History</h2>
                           <p className="text-xs text-slate-400">{history.length} items in this session</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {history.length > 0 && (
                          <>
                            <button 
                                onClick={() => setHistory([])}
                                className="flex items-center gap-1 px-3 py-1.5 rounded bg-red-900/30 text-red-400 hover:bg-red-900/50 hover:text-red-300 text-xs font-medium transition-colors"
                            >
                                <Trash2 className="w-3.5 h-3.5" /> Clear list
                            </button>
                            <button 
                                onClick={downloadAllHistory}
                                className="flex items-center gap-1 px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors shadow-lg shadow-indigo-500/20"
                            >
                                <Download className="w-3.5 h-3.5" /> Download All
                            </button>
                          </>
                        )}
                        <button 
                            onClick={() => setIsHistoryOpen(false)}
                            className="ml-2 p-2 hover:bg-slate-800 rounded-full text-slate-400 hover:text-white transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Modal Grid */}
                <div className="p-4 overflow-y-auto custom-scrollbar flex-1 bg-slate-950/50">
                    {history.length === 0 ? (
                        <div className="h-64 flex flex-col items-center justify-center text-slate-500 gap-3">
                            <History className="w-12 h-12 opacity-20" />
                            <p>No history available yet.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                            {history.map((item) => (
                                <div key={item.id} className="relative group bg-slate-900 border border-slate-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow aspect-square">
                                    <img 
                                      src={item.url} 
                                      alt="History item" 
                                      className="w-full h-full object-cover"
                                    />
                                    {/* Overlay */}
                                    <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2">
                                        <button 
                                            onClick={() => downloadImage(item.url, `history-${item.id.slice(0,6)}.png`)}
                                            className="p-2 bg-indigo-600 rounded-full text-white hover:bg-indigo-500 transform scale-90 hover:scale-100 transition-all shadow-lg"
                                            title="Download"
                                        >
                                            <Download className="w-4 h-4" />
                                        </button>
                                        <button 
                                            onClick={() => setOutputImage(item.url)}
                                            className="p-2 bg-slate-700 rounded-full text-white hover:bg-slate-600 transform scale-90 hover:scale-100 transition-all shadow-lg"
                                            title="View in Output"
                                        >
                                            <ImageIcon className="w-4 h-4" />
                                        </button>
                                        <span className="text-[10px] text-slate-300 font-mono mt-2 bg-black/50 px-2 py-0.5 rounded">
                                            {new Date(item.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
             </div>
          </div>
        )}

      </main>
    </div>
  );
};

export default App;
