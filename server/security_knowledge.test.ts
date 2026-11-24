import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type Database from 'better-sqlite3';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {
  assertSafeExternalUrl,
  detectDisallowedExecutableMagic,
  inspectUploadedBinarySafety,
  isPrivateOrReservedIp,
  validateExternalHttpUrl,
  validateImageAttachmentBinary,
} from './security';

let db: Database.Database;
let tempDbPath = '';
let extractDocumentContent: typeof import('./knowledge').extractDocumentContent;

before(async () => {
  tempDbPath = path.join(os.tmpdir(), `loody-sec-knowledge-${process.pid}-${Date.now()}.db`);
  process.env.LOODY_DB_PATH = tempDbPath;
  const dbMod = await import('./db');
  db = dbMod.db;
  const knowledgeMod = await import('./knowledge');
  extractDocumentContent = knowledgeMod.extractDocumentContent;
});

after(() => {
  db.close();
  for (const ext of ['', '-wal', '-shm']) {
    fs.rmSync(`${tempDbPath}${ext}`, { force: true });
  }
});

function buildMinimalValidPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const streamContent = `BT\n/F1 14 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'latin1')} >>\nstream\n${streamContent}endstream\nendobj\n`,
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += obj;
  }
  const xrefPos = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

test('SSRF protection blocks localhost, private ranges, metadata IPs, creds, and non-HTTP schemes', async () => {
  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('10.20.30.40'), true);
  assert.equal(isPrivateOrReservedIp('172.16.5.1'), true);
  assert.equal(isPrivateOrReservedIp('192.168.1.50'), true);
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('fe80::1'), true);
  assert.equal(isPrivateOrReservedIp('fd12:3456:789a::1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);

  const blockedUrls = [
    'http://localhost:3000/api',
    'http://127.0.0.1:8080/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/internal',
    'http://172.16.0.10/status',
    'http://192.168.0.1/router',
    'http://[::1]:3000/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://service.internal/secret',
    'https://user:pass@example.com/resource',
    'file:///etc/passwd',
    'http://2130706433/',
  ];
  for (const url of blockedUrls) {
    assert.equal(validateExternalHttpUrl(url).valid, false, `Expected blocked URL: ${url}`);
    assert.equal((await assertSafeExternalUrl(url)).ok, false, `Expected async blocked URL: ${url}`);
  }

  assert.equal(validateExternalHttpUrl('https://example.com/docs').valid, true);
  assert.equal((await assertSafeExternalUrl('https://93.184.216.34/page')).ok, true);
});

test('Executable magic-byte & spoofed MIME detection blocks disguised binaries safely', () => {
  const peHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
  const elfHeader = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
  const machoHeader = Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0x00, 0x00]);

  assert.equal(detectDisallowedExecutableMagic(peHeader).blocked, true);
  assert.equal(detectDisallowedExecutableMagic(elfHeader).blocked, true);
  assert.equal(detectDisallowedExecutableMagic(machoHeader).blocked, true);

  // Spoofed executable disguised as .txt or .pdf
  assert.equal(
    inspectUploadedBinarySafety({ fileName: 'notes.txt', mimeType: 'text/plain', buffer: peHeader }).safe,
    false
  );
  assert.equal(
    inspectUploadedBinarySafety({ fileName: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not-a-pdf') }).safe,
    false
  );
  assert.equal(
    inspectUploadedBinarySafety({ fileName: 'payload.sh', mimeType: 'text/plain', buffer: Buffer.from('#!/bin/sh\n') }).safe,
    false
  );

  // Legitimate PNG, PDF, and UTF-8 files pass
  const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(inspectUploadedBinarySafety({ fileName: 'diagram.png', mimeType: 'image/png', buffer: validPng }).safe, true);
  assert.equal(
    inspectUploadedBinarySafety({
      fileName: 'spec.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n1 0 obj\n', 'latin1'),
    }).safe,
    true
  );
  assert.equal(
    inspectUploadedBinarySafety({
      fileName: 'readme.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# LOODY Architecture Notes\nClean plain markdown.', 'utf8'),
    }).safe,
    true
  );

  // Strict chat image attachment magic-byte verification
  assert.equal(
    validateImageAttachmentBinary({
      name: 'ok.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64'),
    }).valid,
    true
  );
  assert.equal(
    validateImageAttachmentBinary({
      name: 'ok.jpg',
      mimeType: 'image/jpeg',
      dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString('base64'),
    }).valid,
    true
  );
  assert.equal(
    validateImageAttachmentBinary({
      name: 'ok.gif',
      mimeType: 'image/gif',
      dataBase64: Buffer.from('GIF89a\x01\x00\x01\x00', 'ascii').toString('base64'),
    }).valid,
    true
  );
  assert.equal(
    validateImageAttachmentBinary({
      name: 'ok.webp',
      mimeType: 'image/webp',
      dataBase64: Buffer.from('RIFF\x10\x00\x00\x00WEBP', 'ascii').toString('base64'),
    }).valid,
    true
  );
  // Spoofed/mismatched/truncated images fail
  assert.equal(
    validateImageAttachmentBinary({
      name: 'malware.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]).toString('base64'),
    }).valid,
    false
  );
  assert.equal(
    validateImageAttachmentBinary({
      name: 'png-as-jpg.jpg',
      mimeType: 'image/jpeg',
      dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
    }).valid,
    false
  );
  assert.equal(
    validateImageAttachmentBinary({
      name: 'corrupt.png',
      mimeType: 'image/png',
      dataBase64: '!!!not-base64!!!',
    }).valid,
    false
  );
});

test('extractDocumentContent parses real XLSX, DOCX, and PDF binary buffers', async () => {
  // 1. Real XLSX buffer via SheetJS
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Model', 'LatencyMs', 'Status'],
    ['Sonic 3', 310, 'operational'],
    ['Lodie 5.5', 1120, 'operational'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Registry');
  const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const xlsxRes = await extractDocumentContent({
    fileName: 'models.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: xlsxBuf,
  });
  assert.equal(xlsxRes.fileCategory, 'spreadsheet');
  assert.match(xlsxRes.extractedText, /Registry/);
  assert.match(xlsxRes.extractedText, /Sonic 3,310,operational/);

  // 2. Real DOCX buffer via JSZip
  const docxZip = new JSZip();
  docxZip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
  );
  docxZip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>LOODY Phase 1 DOCX Parser Verified</w:t></w:r></w:p></w:body></w:document>'
  );
  const docxBuf = await docxZip.generateAsync({ type: 'nodebuffer' });
  const docxRes = await extractDocumentContent({
    fileName: 'architecture.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: docxBuf,
  });
  assert.equal(docxRes.fileCategory, 'document');
  assert.match(docxRes.extractedText, /LOODY Phase 1 DOCX Parser Verified/);

  // 3. Real PDF binary buffer via pdf-parse
  const pdfBuf = buildMinimalValidPdf('LOODY Roadmap PDF Extraction Test');
  const pdfRes = await extractDocumentContent({
    fileName: 'roadmap.pdf',
    mimeType: 'application/pdf',
    buffer: pdfBuf,
  });
  assert.equal(pdfRes.fileCategory, 'document');
  assert.match(pdfRes.extractedText, /LOODY Roadmap PDF Extraction Test/);
});
