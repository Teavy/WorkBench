import React, { useEffect, useState } from 'react';
import { Film, GitBranch, Orbit } from 'lucide-react';
import Synthesizer from './App';
import WorkflowPage from './workflow/WorkflowPage';
import ChromaPage from './chroma/ChromaPage';

type Module = 'synthesizer' | 'workflow' | 'chroma';

function moduleFromHash(): Module {
  return window.location.hash === '#chroma' ? 'chroma' : window.location.hash === '#workflow' ? 'workflow' : 'synthesizer';
}

export default function WorkbenchApp() {
  const [active, setActive] = useState<Module>(moduleFromHash);

  useEffect(() => {
    const update = () => setActive(moduleFromHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <nav className="h-14 px-4 md:px-8 border-b border-slate-800 bg-[#090b19] flex items-center justify-between gap-4 relative z-50">
        <span className="text-sm font-bold tracking-wide whitespace-nowrap">Codex <span className="gradient-text">Workbench</span></span>
        <div className="flex gap-1 rounded-xl border border-slate-800 p-1 bg-slate-900/80" aria-label="Workbench modules">
          <a href="#synthesizer" aria-current={active === 'synthesizer' ? 'page' : undefined}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs md:text-sm transition-colors ${active === 'synthesizer' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}>
            <Orbit size={15} /> <span>View Synthesizer</span>
          </a>
          <a href="#workflow" aria-current={active === 'workflow' ? 'page' : undefined}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs md:text-sm transition-colors ${active === 'workflow' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}>
            <GitBranch size={15} /> <span>Workflow Canvas</span>
          </a>
          <a href="#chroma" aria-current={active === 'chroma' ? 'page' : undefined}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs md:text-sm transition-colors ${active === 'chroma' ? 'bg-emerald-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}>
            <Film size={15} /> <span>MP4 BG Removal</span>
          </a>
        </div>
      </nav>
      {/* Keep both modules mounted so switching tools never discards an unfinished local job. */}
      <div hidden={active !== 'synthesizer'}><Synthesizer /></div>
      <div hidden={active !== 'workflow'}><WorkflowPage /></div>
      <div hidden={active !== 'chroma'}><ChromaPage /></div>
    </div>
  );
}
