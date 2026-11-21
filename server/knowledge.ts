import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import JSZip from 'jszip';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';
import { chunkDocumentText, classifyFileCategory, rankKnowledgeChunks, type StoredChunkCandidate } from '../src/shared/rag';
import type { FileCategory, KnowledgeCitation } from '../src/shared/types';
import { db, UPLOADS_DIR } from './db';

const EMBEDDING_MODEL = 'gemini-embedding-2';

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export async function generateEmbeddingVector(text: string): Promise<{ vector: number[] | null; tokensEstimated: number }> {
  const trimmed = text.trim().slice(0, 6000);
  if (!trimmed) return { vector: null, tokensEstimated: 0 };
  const ai = getGeminiClient();
  if (!ai) return { vector: null, tokensEstimated: 0 };

  try {
    const resp = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: trimmed,
    });
    const values = resp.embeddings?.[0]?.values;
    if (Array.isArray(values) && values.length > 0) {
      return {
        vector: values.slice(0, 768),
        tokensEstimated: Math.max(1, Math.ceil(trimmed.length / 4)),
      };
    }
    return { vector: null, tokensEstimated: 0 };
  } catch {
    return { vector: null, tokensEstimated: 0 };
  }
}

export async function indexKnowledgeSource(params: {
  userId: string;
  sourceType: 'workspace_file' | 'project_file' | 'memory';
  sourceId: string;
  projectId: string | null;
  title: string;
  text: string;
  computeEmbeddings?: boolean;
}): Promise<{ chunkCount: number; embeddedCount: number }> {
  db.prepare('DELETE FROM knowledge_chunks WHERE user_id = ? AND source_id = ?').run(params.userId, params.sourceId);

  const chunks = chunkDocumentText(params.text, 900, 140);
  if (chunks.length === 0) return { chunkCount: 0, embeddedCount: 0 };

  const insertStmt = db.prepare(`
    INSERT INTO knowledge_chunks (
      id, user_id, source_type, source_id, project_id, title, chunk_index, content, embedding_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  let embeddedCount = 0;

  for (let i = 0; i < chunks.length; i++) {
    let embeddingJson: string | null = null;
    if (params.computeEmbeddings && i < 4) {
      const emb = await generateEmbeddingVector(`${params.title}\n${chunks[i]}`);
      if (emb.vector) {
        embeddingJson = JSON.stringify(emb.vector);
        embeddedCount++;
      }
    }
    insertStmt.run(
      crypto.randomUUID(),
      params.userId,
      params.sourceType,
      params.sourceId,
      params.projectId,
      params.title.slice(0, 160),
      i,
      chunks[i],
      embeddingJson,
      now
    );
  }

  return { chunkCount: chunks.length, embeddedCount };
}

export function deleteKnowledgeSourceChunks(userId: string, sourceId: string): void {
  db.prepare('DELETE FROM knowledge_chunks WHERE user_id = ? AND source_id = ?').run(userId, sourceId);
}

export async function retrieveKnowledgeCitations(params: {
  userId: string;
  projectId: string | null;
  query: string;
  topK?: number;
  allowEmbeddings?: boolean;
}): Promise<KnowledgeCitation[]> {
  const rows = params.projectId
    ? (db
        .prepare(
          'SELECT id, source_type, source_id, project_id, title, content, embedding_json FROM knowledge_chunks WHERE user_id = ? AND (project_id IS NULL OR project_id = ?)'
        )
        .all(params.userId, params.projectId) as Array<Record<string, unknown>>)
    : (db
        .prepare(
          'SELECT id, source_type, source_id, project_id, title, content, embedding_json FROM knowledge_chunks WHERE user_id = ? AND project_id IS NULL'
        )
        .all(params.userId) as Array<Record<string, unknown>>);

  if (rows.length === 0) return [];

  const candidates: StoredChunkCandidate[] = rows.map((r) => ({
    id: String(r.id),
    sourceType: r.source_type as StoredChunkCandidate['sourceType'],
    sourceId: String(r.source_id),
    projectId: r.project_id ? String(r.project_id) : null,
    title: String(r.title),
    content: String(r.content),
    embedding: r.embedding_json ? (JSON.parse(String(r.embedding_json)) as number[]) : null,
  }));

  const hasAnyEmbeddings = candidates.some((c) => Array.isArray(c.embedding) && c.embedding.length > 0);
  let queryEmbedding: number[] | null = null;
  if (hasAnyEmbeddings && params.allowEmbeddings !== false) {
    const emb = await generateEmbeddingVector(params.query);
    queryEmbedding = emb.vector;
  }

  return rankKnowledgeChunks({
    query: params.query,
    queryEmbedding,
    candidates,
    topK: params.topK ?? 4,
    minScore: 0.14,
  });
}

function sanitizeText(raw: string): string {
  return raw.replace(/\0/g, '').trim().slice(0, 140_000);
}

export async function extractDocumentContent(params: {
  fileName: string;
  mimeType: string;
  buffer?: Buffer;
  preExtractedText?: string;
}): Promise<{ extractedText: string; fileCategory: FileCategory }> {
  const category = classifyFileCategory(params.fileName, params.mimeType);
  const lowerName = params.fileName.toLowerCase();

  if (!params.buffer || params.buffer.length === 0) {
    return {
      extractedText: sanitizeText(params.preExtractedText ?? ''),
      fileCategory: category,
    };
  }

  try {
    if (category === 'document' && (params.mimeType === 'application/pdf' || lowerName.endsWith('.pdf'))) {
      const parser = new PDFParse({ data: params.buffer });
      try {
        const result = await parser.getText();
        return {
          extractedText: sanitizeText(result.text || '[PDF contains no extractable text layer]'),
          fileCategory: category,
        };
      } finally {
        await parser.destroy().catch(() => null);
      }
    }

    if (
      category === 'document' &&
      (params.mimeType.includes('wordprocessingml') || lowerName.endsWith('.docx'))
    ) {
      const zip = await JSZip.loadAsync(params.buffer);
      const docXmlFile = zip.file('word/document.xml');
      if (docXmlFile) {
        const xml = await docXmlFile.async('string');
        const plain = xml
          .replace(/<\/w:p>/g, '\n')
          .replace(/<w:tab\/>/g, '\t')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        return {
          extractedText: sanitizeText(plain),
          fileCategory: category,
        };
      }
    }

    if (
      category === 'spreadsheet' &&
      (lowerName.endsWith('.xlsx') ||
        lowerName.endsWith('.xls') ||
        params.mimeType.includes('spreadsheet') ||
        params.mimeType.includes('excel'))
    ) {
      const workbook = XLSX.read(params.buffer, { type: 'buffer' });
      const parts: string[] = [];
      for (const sheetName of workbook.SheetNames.slice(0, 8)) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        const csv = XLSX.utils.sheet_to_csv(sheet);
        parts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
      }
      return {
        extractedText: sanitizeText(parts.join('\n\n')),
        fileCategory: category,
      };
    }

    if (category === 'text' || category === 'code' || category === 'spreadsheet') {
      return {
        extractedText: sanitizeText(params.buffer.toString('utf8')),
        fileCategory: category,
      };
    }

    if (category === 'image' || category === 'audio' || category === 'video') {
      const fallbackNote = params.preExtractedText?.trim();
      return {
        extractedText: sanitizeText(
          fallbackNote ||
            `${category.toUpperCase()} media file "${params.fileName}" (${params.mimeType}, ${params.buffer.length.toLocaleString()} bytes). Available for download and preview.`
        ),
        fileCategory: category,
      };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Parser error';
    return {
      extractedText: sanitizeText(
        params.preExtractedText || `[Extraction warning for ${params.fileName}: ${errMsg}]`
      ),
      fileCategory: category,
    };
  }

  return {
    extractedText: sanitizeText(params.preExtractedText ?? ''),
    fileCategory: category,
  };
}

export function saveUserBinaryFile(params: {
  userId: string;
  fileId: string;
  buffer: Buffer;
}): string {
  const safeUser = params.userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeId = params.fileId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const userDir = path.join(UPLOADS_DIR, safeUser);
  fs.mkdirSync(userDir, { recursive: true });
  const relPath = path.join(safeUser, `${safeId}.bin`);
  const fullPath = path.resolve(UPLOADS_DIR, relPath);
  if (!fullPath.startsWith(path.resolve(UPLOADS_DIR))) {
    throw new Error('Invalid storage path.');
  }
  fs.writeFileSync(fullPath, params.buffer);
  return relPath;
}

export function resolveUserBinaryPath(relPath: string | null | undefined): string | null {
  if (!relPath) return null;
  const fullPath = path.resolve(UPLOADS_DIR, relPath);
  if (!fullPath.startsWith(path.resolve(UPLOADS_DIR))) return null;
  if (!fs.existsSync(fullPath)) return null;
  return fullPath;
}

export function removeUserBinaryFile(relPath: string | null | undefined): void {
  const resolved = resolveUserBinaryPath(relPath);
  if (resolved) {
    fs.unlinkSync(resolved);
  }
}

export async function runServerTextAnalysis(params: {
  instruction: string;
  userPrompt: string;
}): Promise<{ text: string; inputTokens: number; outputTokens: number; modelUsed: string }> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured on the server for AI document analysis.');
  }
  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: params.userPrompt,
    config: {
      systemInstruction: params.instruction,
    },
  });
  return {
    text: (response.text ?? '').trim(),
    inputTokens: Number(response.usageMetadata?.promptTokenCount ?? 0),
    outputTokens: Number(response.usageMetadata?.candidatesTokenCount ?? 0),
    modelUsed: 'gemini-3.1-flash-lite',
  };
}
