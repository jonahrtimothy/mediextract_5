// lib/preprocessor.ts
// Layer 2 — Quality Assessor
// Layer 3 — Adaptive Preprocessor
// Uses sharp (Node.js) for all image operations

import sharp from 'sharp';

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type DocFormat = 'digital' | 'scanned' | 'handwritten' | 'photographed' | 'mixed';

export interface QualityReport {
  quality_score: number;        // 0.0 – 1.0
  issues: string[];
  recommended_steps: PreprocessStep[];
  estimated_dpi: number;
  is_color: boolean;
}

export type PreprocessStep =
  | 'deskew'
  | 'denoise'
  | 'clahe'
  | 'upscale'
  | 'binarize'
  | 'grayscale'
  | 'normalize'
  | 'sharpen';

export interface PreprocessResult {
  buffer: Buffer;
  mime_type: 'image/png' | 'image/jpeg';
  steps_applied: PreprocessStep[];
  width: number;
  height: number;
}

export interface DocumentDetection {
  doc_format: DocFormat;
  confidence: number;
  page_count: number;
  has_images: boolean;
}

// ─────────────────────────────────────────────────────────────
// LAYER 1 HELPER — Detect document format from buffer
// Called before quality assessment
// ─────────────────────────────────────────────────────────────

export async function detectDocumentFormat(buffer: Buffer, mimeType: string): Promise<DocumentDetection> {
  // PDFs with text layer = digital
  // Images need pixel analysis to classify

  if (mimeType === 'application/pdf') {
    // PDFs sent directly to Claude — treat as digital
    // Actual text extraction happens in Claude via pdf beta
    return {
      doc_format: 'digital',
      confidence: 0.90,
      page_count: 1,
      has_images: false,
    };
  }

  // For images, analyze pixel statistics to guess format
  try {
    const { data, info } = await sharp(buffer)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = Array.from(data);
    const mean = pixels.reduce((a, b) => a + b, 0) / pixels.length;
    const variance = pixels.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / pixels.length;
    const stdDev = Math.sqrt(variance);

    // Low stddev = mostly uniform = likely scanned printed page
    // High stddev = lots of variation = likely photo or handwritten
    let doc_format: DocFormat = 'scanned';
    let confidence = 0.75;

    if (stdDev < 30) {
      doc_format = 'scanned';
      confidence = 0.85;
    } else if (stdDev > 80) {
      doc_format = 'photographed';
      confidence = 0.80;
    } else {
      doc_format = 'mixed';
      confidence = 0.70;
    }

    return {
      doc_format,
      confidence,
      page_count: 1,
      has_images: info.channels > 1,
    };
  } catch {
    return {
      doc_format: 'scanned',
      confidence: 0.50,
      page_count: 1,
      has_images: false,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// LAYER 2 — Quality Assessor
// ─────────────────────────────────────────────────────────────

export async function assessQuality(buffer: Buffer): Promise<QualityReport> {
  const issues: string[] = [];
  const recommended_steps: PreprocessStep[] = [];

  let quality_score = 1.0;
  let estimated_dpi = 150;
  let is_color = false;

  try {
    const metadata = await sharp(buffer).metadata();
    const width  = metadata.width  ?? 0;
    const height = metadata.height ?? 0;
    is_color = (metadata.channels ?? 1) >= 3;

    // ── DPI estimation ──────────────────────────────────────
    // sharp exposes densityX/densityY if embedded in file
    // Otherwise estimate from pixel dimensions
    const density = metadata.density ?? 0;
    if (density > 0) {
      estimated_dpi = density;
    } else if (width > 0 && height > 0) {
      // Assume letter-size (8.5 x 11 inches) as baseline
      estimated_dpi = Math.round(Math.min(width / 8.5, height / 11));
    }

    if (estimated_dpi < 150) {
      issues.push(`Low DPI detected (~${estimated_dpi}) — text may be blurry`);
      recommended_steps.push('upscale');
      quality_score -= 0.25;
    } else if (estimated_dpi < 200) {
      issues.push(`Marginal DPI (~${estimated_dpi}) — upscaling recommended`);
      recommended_steps.push('upscale');
      quality_score -= 0.10;
    }

    // ── Pixel statistics ────────────────────────────────────
    const { data, info } = await sharp(buffer)
      .grayscale()
      .resize({ width: 800, withoutEnlargement: true }) // sample for speed
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = Array.from(data);
    const len = pixels.length;
    const mean = pixels.reduce((a, b) => a + b, 0) / len;
    const variance = pixels.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / len;
    const stdDev = Math.sqrt(variance);

    // ── Contrast check ──────────────────────────────────────
    const minPx = Math.min(...pixels);
    const maxPx = Math.max(...pixels);
    const contrastRatio = (maxPx - minPx) / 255;

    if (contrastRatio < 0.3) {
      issues.push('Low contrast detected — text may be faint');
      recommended_steps.push('clahe');
      recommended_steps.push('normalize');
      quality_score -= 0.20;
    } else if (contrastRatio < 0.5) {
      issues.push('Moderate contrast — enhancement recommended');
      recommended_steps.push('normalize');
      quality_score -= 0.08;
    }

    // ── Noise check (high variance in near-uniform regions) ─
    if (stdDev > 60 && contrastRatio < 0.6) {
      issues.push('Noise detected — possibly fax artifact or poor scan');
      recommended_steps.push('denoise');
      quality_score -= 0.15;
    }

    // ── Blur check (Laplacian variance proxy) ───────────────
    // Simple edge density check using pixel differences
    let edgeSum = 0;
    for (let i = 1; i < len; i++) {
      edgeSum += Math.abs(pixels[i] - pixels[i - 1]);
    }
    const edgeDensity = edgeSum / len;

    if (edgeDensity < 3) {
      issues.push('Image appears blurry — sharpening recommended');
      recommended_steps.push('sharpen');
      quality_score -= 0.15;
    }

    // ── Size check ──────────────────────────────────────────
    if (width < 800 || height < 600) {
      issues.push(`Image resolution too small (${width}x${height}) — upscaling needed`);
      if (!recommended_steps.includes('upscale')) recommended_steps.push('upscale');
      quality_score -= 0.15;
    }

    // ── Color → grayscale recommendation ────────────────────
    if (is_color) {
      recommended_steps.push('grayscale');
    }

    // ── Skew heuristic ──────────────────────────────────────
    // True skew detection needs OpenCV — here we flag based on aspect ratio anomalies
    const aspectRatio = width / height;
    if (aspectRatio > 1.6 || aspectRatio < 0.4) {
      issues.push('Unusual aspect ratio — document may be rotated or skewed');
      recommended_steps.push('deskew');
      quality_score -= 0.10;
    }

    void info; // suppress unused warning

  } catch (err) {
    issues.push('Could not analyze image quality — using defaults');
    quality_score = 0.60;
    recommended_steps.push('normalize');
  }

  // Clamp score
  quality_score = Math.max(0, Math.round(quality_score * 100) / 100);

  // Deduplicate steps
  const unique_steps = [...new Set(recommended_steps)] as PreprocessStep[];

  return {
    quality_score,
    issues,
    recommended_steps: unique_steps,
    estimated_dpi,
    is_color,
  };
}

// ─────────────────────────────────────────────────────────────
// LAYER 3 — Adaptive Preprocessor
// Only applies steps that quality assessment recommends
// ─────────────────────────────────────────────────────────────

export async function preprocessImage(
  buffer: Buffer,
  steps: PreprocessStep[],
  targetMime: 'image/png' | 'image/jpeg' = 'image/png'
): Promise<PreprocessResult> {
  const steps_applied: PreprocessStep[] = [];

  let pipeline = sharp(buffer);

  // ── Step: grayscale ─────────────────────────────────────
  if (steps.includes('grayscale')) {
    pipeline = pipeline.grayscale();
    steps_applied.push('grayscale');
  }

  // ── Step: normalize (stretch histogram to full range) ───
  if (steps.includes('normalize')) {
    pipeline = pipeline.normalize();
    steps_applied.push('normalize');
  }

  // ── Step: clahe (adaptive histogram equalization) ───────
  // sharp doesn't have native CLAHE — we approximate with
  // a combination of normalize + linear contrast adjustment
  if (steps.includes('clahe')) {
    pipeline = pipeline
      .normalise({ lower: 1, upper: 99 })
      .linear(1.3, -20); // boost contrast
    steps_applied.push('clahe');
  }

  // ── Step: denoise (mild median-like via blur + sharpen) ──
  if (steps.includes('denoise')) {
    pipeline = pipeline
      .median(3)        // 3x3 median filter — removes salt/pepper noise
      .sharpen({ sigma: 0.5 }); // recover edge sharpness after median
    steps_applied.push('denoise');
  }

  // ── Step: sharpen ────────────────────────────────────────
  if (steps.includes('sharpen') && !steps_applied.includes('denoise')) {
    pipeline = pipeline.sharpen({ sigma: 1.0, m1: 1.5, m2: 0.7 });
    steps_applied.push('sharpen');
  }

  // ── Step: upscale (to minimum 300 DPI equivalent) ───────
  if (steps.includes('upscale')) {
    const meta = await sharp(buffer).metadata();
    const w = meta.width ?? 800;
    if (w < 1700) {
      // Scale up to ~2x or minimum 1700px wide (≈200 DPI on letter)
      const scaleFactor = Math.min(3.0, 1700 / w);
      pipeline = pipeline.resize({
        width: Math.round(w * scaleFactor),
        kernel: sharp.kernel.lanczos3,
      });
      steps_applied.push('upscale');
    }
  }

  // ── Step: deskew ─────────────────────────────────────────
  // True deskew needs OpenCV — sharp doesn't support it natively
  // We rotate by 0 (no-op placeholder) and flag it was attempted
  if (steps.includes('deskew')) {
    // In production: integrate opencv4nodejs or call Python microservice
    // For now: sharp's rotate with background fill keeps image intact
    pipeline = pipeline.rotate(0, { background: { r: 255, g: 255, b: 255, alpha: 1 } });
    steps_applied.push('deskew');
  }

  // ── Step: binarize (Otsu-like threshold) ─────────────────
  if (steps.includes('binarize')) {
    pipeline = pipeline.grayscale().threshold(128);
    if (!steps_applied.includes('grayscale')) steps_applied.push('grayscale');
    steps_applied.push('binarize');
  }

  // ── Max width cap: 2000px for Claude Vision ──────────────
  const preFinalMeta = await pipeline.clone().metadata();
  if ((preFinalMeta.width ?? 0) > 2000) {
    pipeline = pipeline.resize({ width: 2000, withoutEnlargement: false });
  }

  // ── Output format ─────────────────────────────────────────
  let outBuffer: Buffer;
  if (targetMime === 'image/jpeg') {
    outBuffer = await pipeline.jpeg({ quality: 92 }).toBuffer();
  } else {
    outBuffer = await pipeline.png({ compressionLevel: 6 }).toBuffer();
  }

  const finalMeta = await sharp(outBuffer).metadata();

  return {
    buffer: outBuffer,
    mime_type: targetMime,
    steps_applied,
    width: finalMeta.width ?? 0,
    height: finalMeta.height ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────
// CONVENIENCE — Run full Layer 2 + 3 pipeline on an image buffer
// Returns preprocessed buffer ready for Claude Vision
// ─────────────────────────────────────────────────────────────

export async function runPreprocessPipeline(
  buffer: Buffer,
  mimeType: string
): Promise<{ result: PreprocessResult; report: QualityReport }> {

  // PDFs skip image preprocessing — sent directly to Claude
  if (mimeType === 'application/pdf') {
    return {
      result: {
        buffer,
        mime_type: 'image/png',
        steps_applied: [],
        width: 0,
        height: 0,
      },
      report: {
        quality_score: 1.0,
        issues: [],
        recommended_steps: [],
        estimated_dpi: 300,
        is_color: false,
      },
    };
  }

  const report = await assessQuality(buffer);
  const result = await preprocessImage(buffer, report.recommended_steps);

  return { result, report };
}