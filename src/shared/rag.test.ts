import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkDocumentText,
  classifyFileCategory,
  cosineSimilarity,
  rankKnowledgeChunks,
  scoreLexicalMatch,
} from './rag';

test('chunkDocumentText splits long text cleanly with bounded chunks', () => {
  const sample = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: Security architecture depends on isolation.`).join('\n');
  const chunks = chunkDocumentText(sample, 400, 60);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 420 && c.length > 0));
});

test('cosineSimilarity handles identical, orthogonal, and mismatched vectors', () => {
  assert.equal(Math.round(cosineSimilarity([1, 0, 1], [1, 0, 1]) * 1000) / 1000, 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 2], [1]), 0);
});

test('rankKnowledgeChunks ranks relevant chunks higher with citations', () => {
  const ranked = rankKnowledgeChunks({
    query: 'SQLite WAL mode concurrency limits',
    candidates: [
      {
        id: 'c1',
        sourceType: 'workspace_file',
        sourceId: 'f1',
        projectId: null,
        title: 'cooking_notes.txt',
        content: 'Boil water with pasta and olive oil for 9 minutes.',
      },
      {
        id: 'c2',
        sourceType: 'project_file',
        sourceId: 'f2',
        projectId: 'p1',
        title: 'db_architecture.md',
        content: 'SQLite WAL mode allows concurrent readers alongside one serialized writer in production.',
      },
    ],
    topK: 3,
  });

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sourceId, 'f2');
  assert.equal(ranked[0].retrievalMethod, 'lexical');
  assert.ok(ranked[0].score > 0.4);
});

test('rankKnowledgeChunks supports embedding vectors when supplied', () => {
  const ranked = rankKnowledgeChunks({
    query: 'vector matching',
    queryEmbedding: [0.9, 0.1, 0],
    candidates: [
      {
        id: 'c1',
        sourceType: 'memory',
        sourceId: 'm1',
        projectId: null,
        title: 'User Memory',
        content: 'User prefers concise TypeScript solutions.',
        embedding: [0.95, 0.05, 0],
      },
      {
        id: 'c2',
        sourceType: 'workspace_file',
        sourceId: 'f1',
        projectId: null,
        title: 'unrelated.txt',
        content: 'Unrelated archive note.',
        embedding: [0, 0, 1],
      },
    ],
    topK: 2,
  });

  assert.equal(ranked[0].sourceId, 'm1');
  assert.equal(ranked[0].retrievalMethod, 'embedding');
  assert.ok(scoreLexicalMatch('vector matching', 'unrelated.txt', 'Unrelated archive note') === 0);
});

test('classifyFileCategory accurately maps document, spreadsheet, image, audio, and video types', () => {
  assert.equal(classifyFileCategory('contract.pdf', 'application/pdf'), 'document');
  assert.equal(classifyFileCategory('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'spreadsheet');
  assert.equal(classifyFileCategory('diagram.png', 'image/png'), 'image');
  assert.equal(classifyFileCategory('voice.mp3', 'audio/mpeg'), 'audio');
  assert.equal(classifyFileCategory('demo.mp4', 'video/mp4'), 'video');
  assert.equal(classifyFileCategory('router.ts', 'text/typescript'), 'code');
});
