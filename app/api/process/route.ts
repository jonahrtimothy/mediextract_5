// app/api/process/route.ts
// MediExtract 5-Layer Pipeline API Route
// POST /api/process — accepts multipart form data with a document file

import { NextRequest, NextResponse } from 'next/server';
import { runPreprocessPipeline, detectDocumentFormat } from '@/lib/preprocessor';
import { runClaudePipeline } from '@/lib/claude';
import { validateFields } from '@/lib/validator';

export const maxDuration = 60; // Vercel max for hobby plan

export async function POST(req: NextRequest) {
  const startTime = Date.now();

  try {
    // ── Parse uploaded file ──────────────────────────────────
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const mimeType = file.type;
    const fileName = file.name;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Validate supported types
    const supported = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/tiff',
      'image/webp',
      'image/bmp',
      'image/heic',
    ];
    if (!supported.includes(mimeType)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${mimeType}` },
        { status: 400 }
      );
    }

    // ── Layer 1 — Document Format Detection ─────────────────
    const formatDetection = await detectDocumentFormat(buffer, mimeType);

    // ── Layer 2 + 3 — Quality Assessment + Preprocessing ────
    const { result: preprocessed, report: qualityReport } =
      await runPreprocessPipeline(buffer, mimeType);

    // Determine which buffer and mime to send to Claude
    // PDFs go directly; images go preprocessed
    const claudeBuffer = mimeType === 'application/pdf' ? buffer : preprocessed.buffer;
    const claudeMime   = mimeType === 'application/pdf' ? mimeType : preprocessed.mime_type;

    // ── Layer 4 — Claude Vision Extraction ──────────────────
    const extraction = await runClaudePipeline(claudeBuffer, claudeMime);

    // ── Layer 5 — Field Validation + Confidence Scoring ─────
    const validation = validateFields(extraction.fields);

    // ── Assemble final response ──────────────────────────────
    const processingTime = Date.now() - startTime;

    return NextResponse.json({
      pipeline: {
        file_name:             fileName,
        file_size_kb:          Math.round(buffer.length / 1024),
        doc_format:            formatDetection.doc_format,
        format_confidence:     formatDetection.confidence,
        quality_score:         qualityReport.quality_score,
        quality_issues:        qualityReport.issues,
        preprocessing_applied: preprocessed.steps_applied,
        doc_type:              extraction.doc_type,
        detection_confidence:  extraction.detection_confidence,
        overall_confidence:    validation.overall_confidence,
        validated_count:       validation.validated_count,
        failed_count:          validation.failed_count,
        warning_count:         validation.warning_count,
        processing_time_ms:    processingTime,
        token_usage:           extraction.token_usage,
      },
      fields:   validation.fields,
      flags:    validation.flags,
      raw_text: extraction.raw_text,
    });

  } catch (err) {
    console.error('Pipeline error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Pipeline failed', detail: message },
      { status: 500 }
    );
  }
}