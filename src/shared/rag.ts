import type { FileCategory, KnowledgeCitation } from './types';

export interface StoredChunkCandidate {
  id: string;
  sourceType: 'workspace_file' | 'project_file' | 'memory';
  sourceId: string;
  projectId: string | null;
  title: string;
  content: string;
  embedding?: number[] | null;
}

export function chunkDocumentText(text: string, maxChunkChars = 900, overlapChars = 140): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChunkChars) return [normalized];

  const chunks: string[] = [];
  let cursor = 0;
  const safeOverlap = Math.min(overlapChars, Math.floor(maxChunkChars / 3));

  while (cursor < normalized.length && chunks.length < 40) {
    let end = Math.min(normalized.length, cursor + maxChunkChars);
    if (end < normalized.length) {
      const breakIdx = Math.max(
        normalized.lastIndexOf('\n\n', end),
        normalized.lastIndexOf('\n', end),
        normalized.lastIndexOf('. ', end),
        normalized.lastIndexOf(' ', end)
      );
      if (breakIdx > cursor + Math.floor(maxChunkChars * 0.45)) {
        end = breakIdx + 1;
      }
    }
    const slice = normalized.slice(cursor, end).trim();
    if (slice.length > 0) {
      chunks.push(slice);
    }
    if (end >= normalized.length) break;
    cursor = Math.max(cursor + 1, end - safeOverlap);
  }
  return chunks;
}

export function tokenizeForSearch(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9\u0600-\u06ff]+/i)
    .filter((token) => token.length >= 2);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export function scoreLexicalMatch(query: string, title: string, content: string): number {
  const queryTerms = Array.from(new Set(tokenizeForSearch(query)));
  if (queryTerms.length === 0) return 0;

  const titleLower = title.toLowerCase();
  const bodyLower = content.toLowerCase();
  const bodyTokens = tokenizeForSearch(content);
  const bodySet = new Set(bodyTokens);

  let score = 0;
  for (const term of queryTerms) {
    if (titleLower.includes(term)) score += 1.6;
    if (bodySet.has(term)) {
      const tf = bodyTokens.filter((t) => t === term).length;
      score += 1 + Math.min(0.8, (tf - 1) * 0.2);
    } else if (bodyLower.includes(term)) {
      score += 0.6;
    }
  }

  return Math.min(1, Number((score / (queryTerms.length * 1.3)).toFixed(4)));
}

export function rankKnowledgeChunks(params: {
  query: string;
  queryEmbedding?: number[] | null;
  candidates: StoredChunkCandidate[];
  topK?: number;
  minScore?: number;
}): KnowledgeCitation[] {
  const topK = params.topK ?? 4;
  const minScore = params.minScore ?? 0.14;
  if (!params.query.trim() || params.candidates.length === 0) return [];

  const scored: KnowledgeCitation[] = [];
  for (const cand of params.candidates) {
    const lexScore = scoreLexicalMatch(params.query, cand.title, cand.content);
    let embScore = 0;
    let usedEmbedding = false;

    if (params.queryEmbedding && cand.embedding && cand.embedding.length === params.queryEmbedding.length) {
      embScore = Math.max(0, cosineSimilarity(params.queryEmbedding, cand.embedding));
      usedEmbedding = true;
    }

    const combined = usedEmbedding ? Number((embScore * 0.72 + lexScore * 0.28).toFixed(4)) : lexScore;
    if (combined >= minScore) {
      const snippet = cand.content.replace(/\s+/g, ' ').trim().slice(0, 220);
      scored.push({
        chunkId: cand.id,
        sourceType: cand.sourceType,
        sourceId: cand.sourceId,
        title: cand.title,
        snippet: snippet + (cand.content.length > 220 ? '...' : ''),
        score: combined,
        retrievalMethod: usedEmbedding ? 'embedding' : 'lexical',
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const seenSource = new Map<string, number>();
  const diverse: KnowledgeCitation[] = [];
  for (const item of scored) {
    const count = seenSource.get(item.sourceId) ?? 0;
    if (count >= 2) continue;
    seenSource.set(item.sourceId, count + 1);
    diverse.push(item);
    if (diverse.length >= topK) break;
  }
  return diverse;
}

export function classifyFileCategory(fileName: string, mimeType: string): FileCategory {
  const lower = fileName.toLowerCase();
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/.test(lower)) return 'image';
  if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac)$/.test(lower)) return 'audio';
  if (mime.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/.test(lower)) return 'video';
  if (
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    mime === 'text/csv' ||
    /\.(xlsx|xls|csv|tsv)$/.test(lower)
  ) {
    return 'spreadsheet';
  }
  if (
    mime === 'application/pdf' ||
    mime.includes('wordprocessingml') ||
    /\.(pdf|docx|doc|rtf)$/.test(lower)
  ) {
    return 'document';
  }
  if (/\.(ts|tsx|js|jsx|py|sql|html|css|json|yml|yaml|xml|sh|go|rs|java)$/.test(lower)) {
    return 'code';
  }
  return 'text';
}
