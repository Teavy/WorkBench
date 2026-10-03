export type NodeKind = 'text' | 'ai-text' | 'image';
export type PortValue = 'text' | 'image';

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  title: string;
  content: string;
}

export interface WorkflowEdge {
  id: string;
  fromNodeId: string;
  fromPort: string;
  toNodeId: string;
  toPort: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowPort {
  id: string;
  label: string;
  value: PortValue;
}

export const PORTS: Record<NodeKind, { inputs: WorkflowPort[]; outputs: WorkflowPort[] }> = {
  text: {
    inputs: [],
    outputs: [{ id: 'text', label: 'Text', value: 'text' }],
  },
  'ai-text': {
    inputs: [
      { id: 'prompt', label: 'Prompt', value: 'text' },
      { id: 'context', label: 'Context', value: 'text' },
    ],
    outputs: [{ id: 'text', label: 'Text', value: 'text' }],
  },
  image: {
    inputs: [
      { id: 'prompt', label: 'Prompt', value: 'text' },
      { id: 'reference', label: 'Reference', value: 'image' },
    ],
    outputs: [{ id: 'image', label: 'Image', value: 'image' }],
  },
};

export const INITIAL_GRAPH: WorkflowGraph = {
  nodes: [
    {
      id: 'welcome-text', kind: 'text', x: 90, y: 180, title: 'Text Input',
      content: 'Write an idea here. You can connect the same text to multiple downstream nodes.',
    },
    {
      id: 'welcome-ai', kind: 'ai-text', x: 540, y: 105, title: 'GPT Text',
      content: 'Expand, rewrite, or summarize the upstream text.',
    },
    {
      id: 'welcome-image', kind: 'image', x: 1000, y: 250, title: 'Image',
      content: '',
    },
  ],
  edges: [
    { id: 'welcome-text-ai', fromNodeId: 'welcome-text', fromPort: 'text', toNodeId: 'welcome-ai', toPort: 'prompt' },
    { id: 'welcome-text-image', fromNodeId: 'welcome-text', fromPort: 'text', toNodeId: 'welcome-image', toPort: 'prompt' },
  ],
};

function reaches(graph: WorkflowGraph, startId: string, targetId: string): boolean {
  const visited = new Set<string>();
  const pending = [startId];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of graph.edges) {
      if (edge.fromNodeId === current) pending.push(edge.toNodeId);
    }
  }
  return false;
}

export function connectionError(
  graph: WorkflowGraph,
  fromNodeId: string,
  fromPort: string,
  toNodeId: string,
  toPort: string,
): string | null {
  const source = graph.nodes.find((node) => node.id === fromNodeId);
  const target = graph.nodes.find((node) => node.id === toNodeId);
  if (!source || !target) return 'Node does not exist';
  if (source.id === target.id) return 'A node cannot connect to itself';
  const output = PORTS[source.kind].outputs.find((port) => port.id === fromPort);
  const input = PORTS[target.kind].inputs.find((port) => port.id === toPort);
  if (!output || !input) return 'Port does not exist';
  if (output.value !== input.value) return 'Port types do not match';
  if (graph.edges.some((edge) => edge.fromNodeId === fromNodeId && edge.fromPort === fromPort && edge.toNodeId === toNodeId && edge.toPort === toPort)) {
    return 'These ports are already connected';
  }
  if (reaches(graph, toNodeId, fromNodeId)) return 'Cycles are not supported';
  return null;
}

export function incomingText(graph: WorkflowGraph, nodeId: string): Array<{ title: string; port: string; text: string }> {
  return graph.edges.flatMap((edge) => {
    if (edge.toNodeId !== nodeId) return [];
    const source = graph.nodes.find((node) => node.id === edge.fromNodeId);
    if (!source || source.kind !== 'text' || edge.fromPort !== 'text') return [];
    return [{ title: source.title, port: edge.toPort, text: source.content }];
  });
}

export function isWorkflowGraph(value: unknown): value is WorkflowGraph {
  if (!value || typeof value !== 'object') return false;
  const graph = value as Partial<WorkflowGraph>;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return false;
  if (!graph.nodes.every((node) => node && typeof node.id === 'string' && node.kind in PORTS &&
    Number.isFinite(node.x) && Number.isFinite(node.y) && typeof node.title === 'string' && typeof node.content === 'string')) return false;
  if (!graph.edges.every((edge) => edge && typeof edge.id === 'string' &&
    typeof edge.fromNodeId === 'string' && typeof edge.fromPort === 'string' &&
    typeof edge.toNodeId === 'string' && typeof edge.toPort === 'string')) return false;
  const nodes = new Set(graph.nodes.map((node) => node.id));
  if (nodes.size !== graph.nodes.length) return false;
  return graph.edges.every((edge) => nodes.has(edge.fromNodeId) && nodes.has(edge.toNodeId));
}
