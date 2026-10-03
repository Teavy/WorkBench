import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionError, incomingText, INITIAL_GRAPH } from '../workflow/graph.ts';

test('one output can feed multiple downstream nodes', () => {
  assert.equal(INITIAL_GRAPH.edges.filter((edge) => edge.fromNodeId === 'welcome-text').length, 2);
  assert.equal(connectionError(INITIAL_GRAPH, 'welcome-text', 'text', 'welcome-ai', 'context'), null);
});

test('multiple upstream nodes can feed one input port', () => {
  const graph = {
    nodes: [
      ...INITIAL_GRAPH.nodes,
      { id: 'second-text', kind: 'text', x: 0, y: 0, title: 'Second Text', content: 'Additional context' },
    ],
    edges: [
      ...INITIAL_GRAPH.edges,
      { id: 'second-context', fromNodeId: 'second-text', fromPort: 'text', toNodeId: 'welcome-ai', toPort: 'context' },
    ],
  };
  assert.equal(connectionError(graph, 'welcome-text', 'text', 'welcome-ai', 'context'), null);
  assert.deepEqual(incomingText(graph, 'welcome-ai').map((entry) => entry.port), ['prompt', 'context']);
});

test('connections reject duplicates, mismatched types, self links, and cycles', () => {
  assert.match(connectionError(INITIAL_GRAPH, 'welcome-text', 'text', 'welcome-ai', 'prompt'), /already connected/);
  assert.match(connectionError(INITIAL_GRAPH, 'welcome-image', 'image', 'welcome-ai', 'context'), /do not match/);
  assert.match(connectionError(INITIAL_GRAPH, 'welcome-ai', 'text', 'welcome-ai', 'context'), /itself/);
  assert.equal(connectionError(INITIAL_GRAPH, 'welcome-ai', 'text', 'welcome-image', 'prompt'), null);
  const graph = {
    ...INITIAL_GRAPH,
    nodes: [...INITIAL_GRAPH.nodes, { id: 'third-ai', kind: 'ai-text', x: 0, y: 0, title: 'AI', content: '' }],
    edges: [...INITIAL_GRAPH.edges, { id: 'ai-chain', fromNodeId: 'welcome-ai', fromPort: 'text', toNodeId: 'third-ai', toPort: 'prompt' }],
  };
  assert.match(connectionError(graph, 'third-ai', 'text', 'welcome-ai', 'context'), /Cycles/);
});
