import React, { useEffect, useRef, useState } from 'react';
import { CircleHelp, FileText, Image as ImageIcon, Plus, RefreshCw, Sparkles, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { connectionError, incomingText, INITIAL_GRAPH, isWorkflowGraph, PORTS, WorkflowEdge, WorkflowGraph, WorkflowNode } from './graph';
import './workflow.css';

const STORAGE_KEY = 'codex-workbench-workflow-v3';
const NODE_WIDTH = 310;
const PORT_TOP = 78;
const PORT_GAP = 34;
const legacySampleContent: Record<string, { old: string; current: string }> = {
  'welcome-text': {
    old: '在这里写下想法。可以把同一段文字连接到多个下游节点。',
    current: 'Write an idea here. You can connect the same text to multiple downstream nodes.',
  },
  'welcome-ai': {
    old: '根据上游内容扩写、改写或提炼文字。',
    current: 'Expand, rewrite, or summarize the upstream text.',
  },
};

function loadGraph(): WorkflowGraph {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (isWorkflowGraph(parsed)) return {
        ...parsed,
        nodes: parsed.nodes.map((node) => {
          const sample = legacySampleContent[node.id];
          return sample && node.content === sample.old ? { ...node, content: sample.current } : node;
        }),
      };
    }
  } catch { /* Start with the sample graph if local storage is unavailable. */ }
  return structuredClone(INITIAL_GRAPH);
}

function nodeName(kind: WorkflowNode['kind']): string {
  return kind === 'text' ? 'Text Input' : kind === 'ai-text' ? 'GPT Text' : 'Image';
}

type Interaction =
  | { kind: 'pan'; pointerX: number; pointerY: number; panX: number; panY: number }
  | { kind: 'drag'; nodeId: string; pointerX: number; pointerY: number; x: number; y: number; scale: number }
  | { kind: 'connect'; nodeId: string; port: string };

export default function WorkflowPage() {
  const [graph, setGraph] = useState<WorkflowGraph>(loadGraph);
  const [selectedId, setSelectedId] = useState<string | null>('welcome-text');
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [message, setMessage] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const interaction = useRef<Interaction | null>(null);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(graph)); } catch { /* Storage may be disabled. */ }
  }, [graph]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 3500);
    return () => window.clearTimeout(timer);
  }, [message]);

  const selected = graph.nodes.find((node) => node.id === selectedId) || null;

  const pointerToWorld = (clientX: number, clientY: number) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - pan.x) / scale, y: (clientY - rect.top - pan.y) / scale };
  };

  const startInteraction = (event: React.PointerEvent, next: Interaction) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    interaction.current = next;
    viewportRef.current?.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const active = interaction.current;
    if (!active) return;
    if (active.kind === 'pan') {
      setPan({ x: active.panX + event.clientX - active.pointerX, y: active.panY + event.clientY - active.pointerY });
    } else if (active.kind === 'drag') {
      const x = Math.round(active.x + (event.clientX - active.pointerX) / active.scale);
      const y = Math.round(active.y + (event.clientY - active.pointerY) / active.scale);
      setGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === active.nodeId ? { ...node, x, y } : node) }));
    } else {
      setDraft(pointerToWorld(event.clientX, event.clientY));
    }
  };

  const handlePointerUp = (event: React.PointerEvent) => {
    const active = interaction.current;
    if (active?.kind === 'connect') {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-port-role="input"]');
      if (target) {
        const toNodeId = target.dataset.nodeId!;
        const toPort = target.dataset.portId!;
        const error = connectionError(graphRef.current, active.nodeId, active.port, toNodeId, toPort);
        if (error) setMessage(error);
        else {
          const edge: WorkflowEdge = { id: crypto.randomUUID(), fromNodeId: active.nodeId, fromPort: active.port, toNodeId, toPort };
          setGraph((current) => ({ ...current, edges: [...current.edges, edge] }));
          setMessage('Connection created');
        }
      }
    }
    interaction.current = null;
    setDraft(null);
    if (viewportRef.current?.hasPointerCapture(event.pointerId)) viewportRef.current.releasePointerCapture(event.pointerId);
  };

  const changeZoom = (next: number, clientX?: number, clientY?: number) => {
    const bounded = Math.max(0.45, Math.min(1.8, next));
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect && clientX !== undefined && clientY !== undefined) {
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      setPan((current) => ({ x: x - (x - current.x) * bounded / scale, y: y - (y - current.y) * bounded / scale }));
    }
    setScale(bounded);
  };

  const addNode = (kind: WorkflowNode['kind']) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const centerX = rect ? (rect.width / 2 - pan.x) / scale : 300;
    const centerY = rect ? (rect.height / 2 - pan.y) / scale : 200;
    const node: WorkflowNode = {
      id: crypto.randomUUID(), kind,
      x: Math.round(centerX - NODE_WIDTH / 2 + Math.random() * 28),
      y: Math.round(centerY - 110 + Math.random() * 28),
      title: nodeName(kind), content: '',
    };
    setGraph((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelectedId(node.id);
  };

  const updateContent = (id: string, content: string) => {
    setGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, content } : node) }));
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setGraph((current) => ({
      nodes: current.nodes.filter((node) => node.id !== selectedId),
      edges: current.edges.filter((edge) => edge.fromNodeId !== selectedId && edge.toNodeId !== selectedId),
    }));
    setSelectedId(null);
  };

  const portPoint = (nodeId: string, portId: string, role: 'input' | 'output') => {
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) return null;
    const list = role === 'input' ? PORTS[node.kind].inputs : PORTS[node.kind].outputs;
    const index = list.findIndex((port) => port.id === portId);
    if (index < 0) return null;
    return { x: node.x + (role === 'output' ? NODE_WIDTH : 0), y: node.y + PORT_TOP + index * PORT_GAP };
  };

  const pathBetween = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const bend = Math.max(75, Math.abs(b.x - a.x) * 0.45);
    return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
  };

  return (
    <div className="workflow-page">
      <header className="workflow-header">
        <div className="workflow-logo"><span className="workflow-logo-mark">◯</span><span>FLOW<span className="workflow-logo-accent">NODE</span></span></div>
        <span className="workflow-header-subtitle">Text · GPT Text · Image</span>
        <div className="workflow-header-actions">
          <span className="workflow-local-badge"><span /> Local canvas</span>
          <button type="button" title="Reset sample canvas" onClick={() => {
            if (window.confirm('Reset the workflow canvas? Locally saved nodes and connections will be replaced.')) {
              setGraph(structuredClone(INITIAL_GRAPH)); setSelectedId('welcome-text'); setScale(1); setPan({ x: 0, y: 0 });
            }
          }}><RefreshCw size={15} /></button>
          <button type="button" title="Help" onClick={() => setMessage('Drag from a right output port to a left input port. Drag a node header to move it, drag empty space to pan, and use Ctrl + wheel to zoom.')}><CircleHelp size={16} /></button>
        </div>
      </header>

      <div className="workflow-viewport" ref={viewportRef}
        onPointerDown={(event) => {
          if (event.target !== viewportRef.current) return;
          setSelectedId(null);
          startInteraction(event, { kind: 'pan', pointerX: event.clientX, pointerY: event.clientY, panX: pan.x, panY: pan.y });
        }}
        onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          changeZoom(scale * (event.deltaY > 0 ? 0.94 : 1.06), event.clientX, event.clientY);
        }}
        style={{ backgroundSize: `${26 * scale}px ${26 * scale}px`, backgroundPosition: `${pan.x}px ${pan.y}px` }}
      >
        <div className="workflow-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}>
          <svg className="workflow-edges" aria-hidden="true">
            {graph.edges.map((edge) => {
              const a = portPoint(edge.fromNodeId, edge.fromPort, 'output');
              const b = portPoint(edge.toNodeId, edge.toPort, 'input');
              if (!a || !b) return null;
              return <path key={edge.id} d={pathBetween(a, b)} />;
            })}
            {draft && interaction.current?.kind === 'connect' && (() => {
              const a = portPoint(interaction.current.nodeId, interaction.current.port, 'output');
              return a ? <path className="workflow-edge-draft" d={pathBetween(a, draft)} /> : null;
            })()}
          </svg>

          {graph.nodes.map((node) => {
            const ports = PORTS[node.kind];
            const incoming = incomingText(graph, node.id);
            return (
              <article key={node.id} className={`workflow-node workflow-node-${node.kind} ${selectedId === node.id ? 'is-selected' : ''}`}
                style={{ left: node.x, top: node.y, width: NODE_WIDTH }} onPointerDown={() => setSelectedId(node.id)}>
                <div className="workflow-node-header" onPointerDown={(event) => {
                  setSelectedId(node.id);
                  startInteraction(event, { kind: 'drag', nodeId: node.id, pointerX: event.clientX, pointerY: event.clientY, x: node.x, y: node.y, scale });
                }}>
                  <span className="workflow-node-kind">{node.kind === 'image' ? <ImageIcon size={15} /> : node.kind === 'ai-text' ? <Sparkles size={15} /> : <FileText size={15} />}{node.title}</span>
                  <span className="workflow-node-status" title={node.kind === 'text' ? 'Local text' : 'Model not connected yet'} />
                </div>
                <div className="workflow-node-body">
                  <div className="workflow-node-port-spacer" style={{ height: Math.max(ports.inputs.length, ports.outputs.length) * PORT_GAP + 12 }} />
                  {node.kind === 'text' ? (
                    <textarea aria-label={`${node.title} content`} value={node.content} onChange={(event) => updateContent(node.id, event.target.value)}
                      placeholder="Click to edit…" spellCheck={false} />
                  ) : node.kind === 'ai-text' ? (
                    <div className="workflow-node-preview">
                      <p className="workflow-muted-label">INSTRUCTIONS</p>
                      <textarea aria-label="GPT Text instruction" value={node.content} onChange={(event) => updateContent(node.id, event.target.value)}
                        placeholder="Enter an instruction for a future GPT connection…" spellCheck={false} />
                      <p className="workflow-muted-label">UPSTREAM · {incoming.length}</p>
                      <div className="workflow-upstream-preview">{incoming.length ? incoming.map((item, index) => <div key={index}><b>{item.port}</b> · {item.text || 'Empty text'}</div>) : 'Connect one or more text nodes'}</div>
                    </div>
                  ) : (
                    <div className="workflow-image-placeholder"><ImageIcon size={26} /><span>Image generation later</span><small>{incoming.length ? `${incoming.length} text input(s) connected` : 'Connect a text prompt'}</small></div>
                  )}
                  <div className="workflow-node-footer">{node.kind === 'text' ? `${node.content.length} chars · local input` : node.kind === 'ai-text' ? 'GPT login & execution: next phase' : 'Image execution: later phase'}</div>
                </div>
                {ports.inputs.map((port, index) => <button key={port.id} type="button" className="workflow-port workflow-port-input" style={{ top: PORT_TOP + index * PORT_GAP }}
                  data-port-role="input" data-node-id={node.id} data-port-id={port.id} title={`${port.label} · ${port.value} input`} aria-label={`${node.title} ${port.label} input port`}>
                  <span className="workflow-port-label">{port.label}</span>
                </button>)}
                {ports.outputs.map((port, index) => <button key={port.id} type="button" className="workflow-port workflow-port-output" style={{ top: PORT_TOP + index * PORT_GAP }}
                  data-port-role="output" data-node-id={node.id} data-port-id={port.id} title={`Drag to connect ${port.value} output`} aria-label={`${node.title} ${port.label} output port`}
                  onPointerDown={(event) => {
                    setSelectedId(node.id);
                    setDraft(pointerToWorld(event.clientX, event.clientY));
                    startInteraction(event, { kind: 'connect', nodeId: node.id, port: port.id });
                  }}><span className="workflow-port-label">{port.label}</span></button>)}
              </article>
            );
          })}
        </div>

        <div className="workflow-zoom-controls" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" title="Zoom in" onClick={() => changeZoom(scale + 0.1)}><ZoomIn size={16} /></button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" title="Zoom out" onClick={() => changeZoom(scale - 0.1)}><ZoomOut size={16} /></button>
          <button type="button" title="Reset view" onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}>Fit</button>
        </div>

        <div className="workflow-command-bar" onPointerDown={(event) => event.stopPropagation()}>
          <div className="workflow-command-top">
            <span><Plus size={18} /> Add node</span>
            <span className="workflow-target">{selected ? `Selected: ${selected.title}` : 'Select a node'}</span>
          </div>
          <textarea className="workflow-command-input" aria-label="Selected node text" value={selected?.content || ''}
            onChange={(event) => selected && updateContent(selected.id, event.target.value)}
            disabled={!selected || selected.kind === 'image'}
            placeholder={selected ? 'Edit the selected node content or instruction…' : 'Select a text node to edit it here…'} />
          <div className="workflow-command-actions">
            <button type="button" onClick={() => addNode('text')}><FileText size={15} /> Text</button>
            <button type="button" onClick={() => addNode('ai-text')}><Sparkles size={15} /> GPT Text</button>
            <button type="button" onClick={() => addNode('image')}><ImageIcon size={15} /> Image</button>
            <span className="workflow-command-divider" />
            <button type="button" disabled={!selected} title="Delete selected node and its connections" onClick={deleteSelected}><Trash2 size={15} /> Delete</button>
          </div>
          <p>Saved locally · Multiple upstream and downstream connections · Drag from an output port to an input port</p>
        </div>
        {message && <div className="workflow-toast" role="status">{message}</div>}
      </div>
    </div>
  );
}
