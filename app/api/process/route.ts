// app/api/process/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { runPreprocessPipeline, detectDocumentFormat } from '@/lib/preprocessor';
import { runClaudePipeline } from '@/lib/claude';
import { validateFields } from '@/lib/validator';

export const maxDuration = 60;

const MAX_FILE_SIZE_MB = 20;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const WARN_PAGE_COUNT = 30;
const SUPPORTED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
  'image/bmp',
  'image/heic',
];

export async function POST(req: NextRequest) {
  const startTime = Date.now();

  try {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        { error: 'Failed to parse upload. Make sure you are sending a multipart form.' },
        { status: 400 }
      );
    }

    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json(
        { error: 'No file uploaded. Please select a document and try again.' },
        { status: 400 }
      );
    }

    if (!SUPPORTED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: "${file.type || 'unknown'}". Please upload a PDF, JPG, PNG, TIFF, WEBP, BMP, or HEIC file.` },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      const fileMb = (file.size / 1024 / 1024).toFixed(1);
      return NextResponse.json(
        { error: `File too large (${fileMb} MB). Maximum allowed size is ${MAX_FILE_SIZE_MB} MB. Try compressing the PDF or splitting into smaller files.` },
        { status: 400 }
      );
    }

    if (file.size === 0) {
      return NextResponse.json(
        { error: 'The uploaded file appears to be empty. Please check the file and try again.' },
        { status: 400 }
      );
    }

    const mimeType = file.type;
    const fileName = file.name;

    let buffer: Buffer;
    try {
      const arrayBuffer = await file.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } catch {
      return NextResponse.json(
        { error: 'Failed to read the uploaded file. Please try again.' },
        { status: 500 }
      );
    }

    // ── Layer 1 — Document Format Detection ─────────────────
    const formatDetection = await detectDocumentFormat(buffer, mimeType);

    // ── Layer 2 + 3 — Quality Assessment + Preprocessing ────
    const { result: preprocessed, report: qualityReport } =
      await runPreprocessPipeline(buffer, mimeType, formatDetection.doc_format);

    const claudeBuffer = mimeType === 'application/pdf' ? buffer : preprocessed.buffer;
    const claudeMime   = mimeType === 'application/pdf' ? mimeType : preprocessed.mime_type;

    // ── Check remaining time before Claude call ──────────────
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > 45000) {
      return NextResponse.json(
        { error: 'Processing is taking too long. Try uploading a smaller or fewer-page document.' },
        { status: 504 }
      );
    }

    // ── Layer 4 — Claude Vision Extraction ──────────────────
    let extraction;
    try {
      extraction = await runClaudePipeline(claudeBuffer, claudeMime, formatDetection.doc_format);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Claude API error';

      if (message.includes('Could not process document')) {
        return NextResponse.json(
          { error: 'Claude could not read this document. The file may be corrupted, password-protected, or contain no readable content.' },
          { status: 422 }
        );
      }
      if (message.includes('too large') || message.includes('token')) {
        return NextResponse.json(
          { error: 'Document is too large for Claude to process. Try splitting the PDF into smaller chunks of 30 pages or less.' },
          { status: 413 }
        );
      }
      if (message.includes('rate_limit')) {
        return NextResponse.json(
          { error: 'API rate limit reached. Please wait 30 seconds and try again.' },
          { status: 429 }
        );
      }

      return NextResponse.json(
        { error: `Claude Vision error: ${message}` },
        { status: 500 }
      );
    }

    // ── Layer 5 — Field Validation ───────────────────────────
    const validation = validateFields(extraction.fields);

    // ── Page count warning ───────────────────────────────────
    const warnings: string[] = [];
    const pageCount = parseInt(String(extraction.fields?.page_count ?? '0'));
    if (pageCount > WARN_PAGE_COUNT) {
      warnings.push(
        `Large document detected (${pageCount} pages). Results may be less accurate for very long documents. Consider splitting into sections.`
      );
    }

    // ── Token limit approaching warning ─────────────────────
    const totalTokens = extraction.token_usage?.total_tokens ?? 0;
    if (totalTokens > 150000) {
      warnings.push(
        `High token usage detected (${totalTokens.toLocaleString()} tokens). Document is near Claude context limit. Consider splitting into smaller files.`
      );
    }

    // ── Assemble final response ──────────────────────────────
    const processingTime = Date.now() - startTime;

    return NextResponse.json({
      pipeline: {
        file_name:             fileName,
        file_size_kb:          Math.round(buffer.length / 1024),
        doc_format:            formatDetection.doc_format,
        format_detail:         formatDetection.format_detail,
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
        review_status:         validation.review_status,
        review_fields:         validation.review_fields,
        warnings,
      },
      fields:   validation.fields,
      flags:    validation.flags,
      raw_text: extraction.raw_text,
    });

  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Pipeline error:', err);

    if (elapsedMs > 55000) {
      return NextResponse.json(
        { error: 'Request timed out. The document may be too large or complex. Try uploading fewer pages at a time.' },
        { status: 504 }
      );
    }

    return NextResponse.json(
      { error: 'Pipeline failed', detail: message },
      { status: 500 }
    );
  }
}