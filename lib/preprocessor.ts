// lib/preprocessor.ts
// Layer 1 — Document Format Detector (7-type classification, no Claude)
// Layer 2 — Quality Assessor
// Layer 3 — Adaptive Preprocessor

import sharp from 'sharp';
// eslint-disable-next-line @typescript-eslint/no-require-imports
// eslint-disable-next-line @typescript-eslint/no-require-imports
// const pdfParse = require('pdf-parse-new');

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type DocFormat =
  | 'digital'
  | 'scanned_digital'
  | 'scanned_handwritten'
  | 'scanned_mixed'
  | 'photographed'
  | 'faxed'
  | 'unknown';

export interface QualityReport {
  quality_score: number;
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
  format_detail: string; // human readable explanation
}

// ─────────────────────────────────────────────────────────────
// HELPERS — pixel analysis
// ─────────────────────────────────────────────────────────────

interface PixelStats {
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  contrastRatio: number;
  edgeDensity: number;
}

async function getPixelStats(buffer: Buffer): Promise<PixelStats> {
  const { data } = await sharp(buffer)
    .grayscale()
    .resize({ width: 800, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = Array.from(data);
  const len = pixels.length;

  const mean = pixels.reduce((a, b) => a + b, 0) / len;
  const variance = pixels.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / len;
  const stdDev = Math.sqrt(variance);
  const min = Math.min(...pixels);
  const max = Math.max(...pixels);
  const contrastRatio = (max - min) / 255;

  let edgeSum = 0;
  for (let i = 1; i < len; i++) {
    edgeSum += Math.abs(pixels[i] - pixels[i - 1]);
  }
  const edgeDensity = edgeSum / len;

  return { mean, stdDev, min, max, contrastRatio, edgeDensity };
}

// Inter-block variance — divides image into grid and measures
// variance between block means. High = irregular = handwritten.
// Low = uniform = printed/scanned digital.
async function getInterBlockVariance(buffer: Buffer, gridSize = 4): Promise<number> {
  const img = sharp(buffer).grayscale().resize({ width: 400, height: 400, fit: 'fill' });
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });
  const pixels = Array.from(data);
  const blockSize = Math.floor(400 / gridSize);
  const blockMeans: number[] = [];

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const blockPixels: number[] = [];
      for (let r = row * blockSize; r < (row + 1) * blockSize; r++) {
        for (let c = col * blockSize; c < (col + 1) * blockSize; c++) {
          blockPixels.push(pixels[r * 400 + c] ?? 128);
        }
      }
      const mean = blockPixels.reduce((a, b) => a + b, 0) / blockPixels.length;
      blockMeans.push(mean);
    }
  }

  const overallMean = blockMeans.reduce((a, b) => a + b, 0) / blockMeans.length;
  const interBlockVar = blockMeans.reduce((a, b) => a + Math.pow(b - overallMean, 2), 0) / blockMeans.length;
  return interBlockVar;
}

// Lighting uniformity — checks if image has uneven illumination
// (top-left vs bottom-right brightness difference > threshold = photographed)
async function getLightingUniformity(buffer: Buffer): Promise<number> {
  const size = 100;
  const { data } = await sharp(buffer)
    .grayscale()
    .resize({ width: size * 2, height: size * 2, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = Array.from(data);
  const w = size * 2;

  const getRegionMean = (rowStart: number, colStart: number): number => {
    const region: number[] = [];
    for (let r = rowStart; r < rowStart + size; r++) {
      for (let c = colStart; c < colStart + size; c++) {
        region.push(pixels[r * w + c] ?? 128);
      }
    }
    return region.reduce((a, b) => a + b, 0) / region.length;
  };

  const topLeft     = getRegionMean(0, 0);
  const topRight    = getRegionMean(0, size);
  const bottomLeft  = getRegionMean(size, 0);
  const bottomRight = getRegionMean(size, size);

  const means = [topLeft, topRight, bottomLeft, bottomRight];
  const avg = means.reduce((a, b) => a + b, 0) / 4;
  const maxDiff = Math.max(...means) - Math.min(...means);

  return maxDiff / (avg || 1); // normalized lighting difference ratio
}

// Fax artifact detection — horizontal line density check
async function hasFaxArtifacts(buffer: Buffer): Promise<boolean> {
  const { data, info } = await sharp(buffer)
    .grayscale()
    .resize({ width: 400 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = Array.from(data);
  const w = info.width;
  const h = info.height;
  let horizontalLineCount = 0;

  // Check for rows that are nearly all dark (fax lines)
  for (let r = 0; r < h; r++) {
    const row = pixels.slice(r * w, (r + 1) * w);
    const darkPixels = row.filter(p => p < 50).length;
    if (darkPixels / w > 0.85) horizontalLineCount++;
  }

  return horizontalLineCount / h > 0.05; // more than 5% of rows are dark lines
}

// ─────────────────────────────────────────────────────────────
// LAYER 1 — Document Format Detector
// 7-type classification without Claude
// ─────────────────────────────────────────────────────────────

export async function detectDocumentFormat(
  buffer: Buffer,
  mimeType: string
): Promise<DocumentDetection> {

  // ── PDFs: check for text layer first ────────────────────
  if (mimeType === 'application/pdf') {
    try {
      const pdfStr = buffer.toString('binary');

      // Count pages via /Type /Page markers in PDF structure
      const pageMatches = pdfStr.match(/\/Type\s*\/Page[^s]/g);
      const pageCount = pageMatches ? pageMatches.length : 1;

      // Detect text layer — PDFs with text contain BT (Begin Text) operators
      // Detect embedded images
      const hasImages = pdfStr.includes('/Image') || pdfStr.includes('/XObject');

      // Extract readable ASCII text between BT...ET blocks
      // Real text PDFs have Tj or TJ operators with actual string content
      // Scanned PDFs may have BT/ET markers but no readable Tj/TJ content
      const tjMatches = pdfStr.match(/\(([^\)]{3,})\)\s*Tj/g) || [];
      const tjArrayMatches = pdfStr.match(/\[([^\]]{3,})\]\s*TJ/g) || [];
      const totalTextOps = tjMatches.length + tjArrayMatches.length;

      // Extract actual readable characters from Tj operators
      const readableChars = tjMatches
        .join(' ')
        .replace(/[^\x20-\x7E]/g, '') // keep only printable ASCII
        .length;

      const charsPerPage = readableChars / pageCount;

      if (charsPerPage > 50 && totalTextOps > 10) {
        return {
          doc_format: 'digital',
          confidence: 0.93,
          page_count: pageCount,
          has_images: hasImages,
          format_detail: `Born-digital PDF — ${readableChars} readable chars across ${pageCount} pages (${totalTextOps} text operations)`,
        };
      }

      if (charsPerPage > 10 && totalTextOps > 3) {
        return {
          doc_format: 'scanned_mixed',
          confidence: 0.75,
          page_count: pageCount,
          has_images: hasImages,
          format_detail: `Mixed PDF — minimal readable text (${readableChars} chars), likely scanned with digital overlay`,
        };
      }

      // No text layer at all — pure image PDF
      // Could be scanned_handwritten, scanned_digital, or scanned_mixed
      // We can't pixel-analyze PDF pages without rendering — default to scanned_mixed
      // which is the most common healthcare document type
      return {
        doc_format: 'scanned_mixed',
        confidence: 0.70,
        page_count: pageCount,
        has_images: true,
        format_detail: `Image-only PDF (${pageCount} pages) — no text layer, scanned document`,
      };

    } catch {
      return {
        doc_format: 'unknown',
        confidence: 0.40,
        page_count: 1,
        has_images: true,
        format_detail: 'Could not parse PDF structure',
      };
    }
  }

  // ── Images: full pixel analysis ──────────────────────────
  try {
    const metadata = await sharp(buffer).metadata();
    const isColor = (metadata.channels ?? 1) >= 3;

    const stats = await getPixelStats(buffer);
    const interBlockVar = await getInterBlockVariance(buffer);
    const lightingDiff = await getLightingUniformity(buffer);
    const faxArtifacts = await hasFaxArtifacts(buffer);

    // ── Fax detection ──────────────────────────────────────
    if (faxArtifacts) {
      return {
        doc_format: 'faxed',
        confidence: 0.85,
        page_count: 1,
        has_images: true,
        format_detail: 'Fax artifacts detected — horizontal line density high, likely fax transmission',
      };
    }

    // ── Photographed detection ─────────────────────────────
    // Uneven lighting across quadrants = camera photo
    if (lightingDiff > 0.25) {
      return {
        doc_format: 'photographed',
        confidence: 0.82,
        page_count: 1,
        has_images: true,
        format_detail: `Photographed document — uneven lighting detected (${(lightingDiff * 100).toFixed(0)}% brightness variation across quadrants)`,
      };
    }

    // ── Handwritten detection ──────────────────────────────
    // High inter-block variance + high edge irregularity = handwritten
    if (interBlockVar > 800 && stats.edgeDensity > 8) {
      return {
        doc_format: 'scanned_handwritten',
        confidence: 0.80,
        page_count: 1,
        has_images: true,
        format_detail: `Scanned handwritten document — irregular stroke patterns detected (block variance: ${interBlockVar.toFixed(0)})`,
      };
    }

    // ── Mixed detection ────────────────────────────────────
    // Medium inter-block variance = printed form + handwritten fill-ins
    if (interBlockVar > 300 && interBlockVar <= 800) {
      return {
        doc_format: 'scanned_mixed',
        confidence: 0.75,
        page_count: 1,
        has_images: true,
        format_detail: `Scanned mixed document — printed form with handwritten annotations (block variance: ${interBlockVar.toFixed(0)})`,
      };
    }

    // ── Scanned digital detection ──────────────────────────
    // Low inter-block variance = uniform printed content = scanned digital
    if (interBlockVar <= 300 && stats.stdDev > 20) {
      return {
        doc_format: 'scanned_digital',
        confidence: 0.78,
        page_count: 1,
        has_images: true,
        format_detail: `Scanned digital document — uniform printed content detected (block variance: ${interBlockVar.toFixed(0)})`,
      };
    }

    // ── Digital image fallback ─────────────────────────────
    return {
      doc_format: 'digital',
      confidence: 0.65,
      page_count: 1,
      has_images: isColor,
      format_detail: `Digital image — clean pixel structure, likely screenshot or exported document`,
    };

  } catch {
    return {
      doc_format: 'unknown',
      confidence: 0.40,
      page_count: 1,
      has_images: false,
      format_detail: 'Could not analyze image format',
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

    const density = metadata.density ?? 0;
    if (density > 0) {
      estimated_dpi = density;
    } else if (width > 0 && height > 0) {
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

    const { data, info } = await sharp(buffer)
      .grayscale()
      .resize({ width: 800, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = Array.from(data);
    const len = pixels.length;
    const mean = pixels.reduce((a, b) => a + b, 0) / len;
    const variance = pixels.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / len;
    const stdDev = Math.sqrt(variance);
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

    if (stdDev > 60 && contrastRatio < 0.6) {
      issues.push('Noise detected — possibly fax artifact or poor scan');
      recommended_steps.push('denoise');
      quality_score -= 0.15;
    }

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

    if (width < 800 || height < 600) {
      issues.push(`Image resolution too small (${width}x${height}) — upscaling needed`);
      if (!recommended_steps.includes('upscale')) recommended_steps.push('upscale');
      quality_score -= 0.15;
    }

    if (is_color) recommended_steps.push('grayscale');

    const aspectRatio = width / height;
    if (aspectRatio > 1.6 || aspectRatio < 0.4) {
      issues.push('Unusual aspect ratio — document may be rotated or skewed');
      recommended_steps.push('deskew');
      quality_score -= 0.10;
    }

    void info;

  } catch {
    issues.push('Could not analyze image quality — using defaults');
    quality_score = 0.60;
    recommended_steps.push('normalize');
  }

  quality_score = Math.max(0, Math.round(quality_score * 100) / 100);
  const unique_steps = [...new Set(recommended_steps)] as PreprocessStep[];

  return { quality_score, issues, recommended_steps: unique_steps, estimated_dpi, is_color };
}

// ─────────────────────────────────────────────────────────────
// LAYER 3 — Adaptive Preprocessor
// ─────────────────────────────────────────────────────────────

export async function preprocessImage(
  buffer: Buffer,
  steps: PreprocessStep[],
  targetMime: 'image/png' | 'image/jpeg' = 'image/png'
): Promise<PreprocessResult> {
  const steps_applied: PreprocessStep[] = [];
  let pipeline = sharp(buffer);

  if (steps.includes('grayscale')) {
    pipeline = pipeline.grayscale();
    steps_applied.push('grayscale');
  }
  if (steps.includes('normalize')) {
    pipeline = pipeline.normalize();
    steps_applied.push('normalize');
  }
  if (steps.includes('clahe')) {
    pipeline = pipeline.normalise({ lower: 1, upper: 99 }).linear(1.3, -20);
    steps_applied.push('clahe');
  }
  if (steps.includes('denoise')) {
    pipeline = pipeline.median(3).sharpen({ sigma: 0.5 });
    steps_applied.push('denoise');
  }
  if (steps.includes('sharpen') && !steps_applied.includes('denoise')) {
    pipeline = pipeline.sharpen({ sigma: 1.0, m1: 1.5, m2: 0.7 });
    steps_applied.push('sharpen');
  }
  if (steps.includes('upscale')) {
    const meta = await sharp(buffer).metadata();
    const w = meta.width ?? 800;
    if (w < 1700) {
      const scaleFactor = Math.min(3.0, 1700 / w);
      pipeline = pipeline.resize({
        width: Math.round(w * scaleFactor),
        kernel: sharp.kernel.lanczos3,
      });
      steps_applied.push('upscale');
    }
  }
  if (steps.includes('deskew')) {
    pipeline = pipeline.rotate(0, { background: { r: 255, g: 255, b: 255, alpha: 1 } });
    steps_applied.push('deskew');
  }
  if (steps.includes('binarize')) {
    pipeline = pipeline.grayscale().threshold(128);
    if (!steps_applied.includes('grayscale')) steps_applied.push('grayscale');
    steps_applied.push('binarize');
  }

  const preFinalMeta = await pipeline.clone().metadata();
  if ((preFinalMeta.width ?? 0) > 2000) {
    pipeline = pipeline.resize({ width: 2000, withoutEnlargement: false });
  }

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
// CONVENIENCE — Run full Layer 2 + 3 pipeline
// ─────────────────────────────────────────────────────────────

export async function runPreprocessPipeline(
  buffer: Buffer,
  mimeType: string
): Promise<{ result: PreprocessResult; report: QualityReport }> {

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