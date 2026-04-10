// lib/preprocessor.ts
// Layer 1 — Document Format Detector (zone-based, 7-type, no Claude)
// Layer 2 — Quality Assessor
// Layer 3 — Format-Aware Adaptive Preprocessor

import sharp from 'sharp';

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
  | 'sharpen'
  | 'adaptive_threshold'
  | 'stroke_enhance';

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
  format_detail: string;
}

// ─────────────────────────────────────────────────────────────
// ZONE ANALYSIS — Core of improved Layer 1
// Divides image into horizontal strips and classifies each
// ─────────────────────────────────────────────────────────────

type ZoneType = 'printed' | 'handwritten' | 'blank';

interface ZoneResult {
  zone: number;
  type: ZoneType;
  strokeVariance: number;
  edgeIrregularity: number;
  density: number;
}

async function analyzeZones(buffer: Buffer, numZones = 8): Promise<ZoneResult[]> {
  const img = sharp(buffer).grayscale().resize({ width: 600 });
  const meta = await img.metadata();
  const h = meta.height ?? 800;
  const w = 600;
  const zoneHeight = Math.floor(h / numZones);

  const { data } = await sharp(buffer)
    .grayscale()
    .resize({ width: w, height: h, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = Array.from(data);
  const results: ZoneResult[] = [];

  for (let z = 0; z < numZones; z++) {
    const rowStart = z * zoneHeight;
    const rowEnd   = Math.min(rowStart + zoneHeight, h);

    // Extract zone pixels
    const zonePixels: number[] = [];
    for (let r = rowStart; r < rowEnd; r++) {
      for (let c = 0; c < w; c++) {
        zonePixels.push(pixels[r * w + c] ?? 255);
      }
    }

    const len = zonePixels.length;
    const mean = zonePixels.reduce((a, b) => a + b, 0) / len;

    // Ink density — percentage of dark pixels (ink)
    const darkPixels = zonePixels.filter(p => p < 128).length;
    const density = darkPixels / len;

    // Blank zone — very few dark pixels
    if (density < 0.02) {
      results.push({ zone: z, type: 'blank', strokeVariance: 0, edgeIrregularity: 0, density });
      continue;
    }

    // Stroke width variance — measure horizontal run lengths of dark pixels
    const runLengths: number[] = [];
    for (let r = rowStart; r < rowEnd; r++) {
      let runLen = 0;
      for (let c = 0; c < w; c++) {
        const px = pixels[r * w + c] ?? 255;
        if (px < 128) {
          runLen++;
        } else if (runLen > 0) {
          runLengths.push(runLen);
          runLen = 0;
        }
      }
      if (runLen > 0) runLengths.push(runLen);
    }

    let strokeVariance = 0;
    if (runLengths.length > 3) {
      const runMean = runLengths.reduce((a, b) => a + b, 0) / runLengths.length;
      strokeVariance = runLengths.reduce((a, b) => a + Math.pow(b - runMean, 2), 0) / runLengths.length;
    }

    // Edge irregularity — variance of pixel-to-pixel differences
    let edgeSum = 0;
    const edgeDiffs: number[] = [];
    for (let i = 1; i < zonePixels.length; i++) {
      const diff = Math.abs(zonePixels[i] - zonePixels[i - 1]);
      edgeSum += diff;
      edgeDiffs.push(diff);
    }
    const edgeMean = edgeSum / edgeDiffs.length;
    const edgeIrregularity = edgeDiffs.reduce((a, b) => a + Math.pow(b - edgeMean, 2), 0) / edgeDiffs.length;

    // Classification per zone:
    // Handwritten: high stroke variance (pen pressure varies) + moderate edge irregularity
    // Printed: low stroke variance (uniform font) + regular edges
    const isHandwritten = strokeVariance > 80 && edgeIrregularity > 15;

    results.push({
      zone: z,
      type: isHandwritten ? 'handwritten' : 'printed',
      strokeVariance,
      edgeIrregularity,
      density,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// LIGHTING UNIFORMITY CHECK
// Uneven illumination across quadrants = photographed
// ─────────────────────────────────────────────────────────────

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

  const means = [
    getRegionMean(0, 0),
    getRegionMean(0, size),
    getRegionMean(size, 0),
    getRegionMean(size, size),
  ];

  const avg = means.reduce((a, b) => a + b, 0) / 4;
  const maxDiff = Math.max(...means) - Math.min(...means);
  return maxDiff / (avg || 1);
}

// ─────────────────────────────────────────────────────────────
// FAX ARTIFACT DETECTION
// ─────────────────────────────────────────────────────────────

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

  for (let r = 0; r < h; r++) {
    const row = pixels.slice(r * w, (r + 1) * w);
    const darkPixels = row.filter(p => p < 50).length;
    if (darkPixels / w > 0.85) horizontalLineCount++;
  }

  return horizontalLineCount / h > 0.05;
}

// ─────────────────────────────────────────────────────────────
// LAYER 1 — Document Format Detector
// ─────────────────────────────────────────────────────────────

export async function detectDocumentFormat(
  buffer: Buffer,
  mimeType: string
): Promise<DocumentDetection> {

  // ── PDFs: raw byte analysis for text layer ───────────────
  if (mimeType === 'application/pdf') {
    try {
      const pdfStr = buffer.toString('binary');

      const pageMatches = pdfStr.match(/\/Type\s*\/Page[^s]/g);
      const pageCount = pageMatches ? pageMatches.length : 1;
      const hasImages = pdfStr.includes('/Image') || pdfStr.includes('/XObject');

      // Real text = Tj/TJ operators with readable ASCII content
      const tjMatches = pdfStr.match(/\(([^\)]{3,})\)\s*Tj/g) || [];
      const tjArrayMatches = pdfStr.match(/\[([^\]]{3,})\]\s*TJ/g) || [];
      const totalTextOps = tjMatches.length + tjArrayMatches.length;

      const readableChars = tjMatches
        .join(' ')
        .replace(/[^\x20-\x7E]/g, '')
        .length;

      const charsPerPage = readableChars / pageCount;

      if (charsPerPage > 50 && totalTextOps > 10) {
        return {
          doc_format: 'digital',
          confidence: 0.93,
          page_count: pageCount,
          has_images: hasImages,
          format_detail: `Born-digital PDF — ${readableChars} readable chars, ${totalTextOps} text ops across ${pageCount} pages`,
        };
      }

      if (charsPerPage > 10 && totalTextOps > 3) {
        return {
          doc_format: 'scanned_mixed',
          confidence: 0.75,
          page_count: pageCount,
          has_images: hasImages,
          format_detail: `Mixed PDF — minimal text layer (${readableChars} chars), likely scanned with digital overlay`,
        };
      }

      // Image-only PDF — can't pixel-analyze without rendering
      // Default to scanned_mixed (most common in healthcare)
      return {
        doc_format: 'scanned_mixed',
        confidence: 0.65,
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

  // ── Images: full zone-based analysis ────────────────────
  try {
    const metadata = await sharp(buffer).metadata();
    const isColor = (metadata.channels ?? 1) >= 3;

    // Fax check first
    const faxArtifacts = await hasFaxArtifacts(buffer);
    if (faxArtifacts) {
      return {
        doc_format: 'faxed',
        confidence: 0.85,
        page_count: 1,
        has_images: true,
        format_detail: 'Fax artifacts detected — horizontal line density high',
      };
    }

    // Lighting check — photographed
    const lightingDiff = await getLightingUniformity(buffer);
    if (lightingDiff > 0.25) {
      return {
        doc_format: 'photographed',
        confidence: 0.82,
        page_count: 1,
        has_images: true,
        format_detail: `Photographed — uneven lighting (${(lightingDiff * 100).toFixed(0)}% brightness variation)`,
      };
    }

    // Zone-based stroke analysis
    const zones = await analyzeZones(buffer);
    const nonBlankZones = zones.filter(z => z.type !== 'blank');

    if (nonBlankZones.length === 0) {
      return {
        doc_format: 'unknown',
        confidence: 0.40,
        page_count: 1,
        has_images: isColor,
        format_detail: 'Document appears blank or unreadable',
      };
    }

    const handwrittenZones = nonBlankZones.filter(z => z.type === 'handwritten').length;
    const printedZones     = nonBlankZones.filter(z => z.type === 'printed').length;
    const hwRatio = handwrittenZones / nonBlankZones.length;
    const prRatio = printedZones / nonBlankZones.length;

    // Mostly handwritten
    if (hwRatio >= 0.75) {
      return {
        doc_format: 'scanned_handwritten',
        confidence: 0.82,
        page_count: 1,
        has_images: true,
        format_detail: `Scanned handwritten — ${handwrittenZones}/${nonBlankZones.length} zones show handwriting patterns (${(hwRatio * 100).toFixed(0)}%)`,
      };
    }

    // Mostly printed
    if (prRatio >= 0.80) {
      return {
        doc_format: 'scanned_digital',
        confidence: 0.80,
        page_count: 1,
        has_images: true,
        format_detail: `Scanned digital — ${printedZones}/${nonBlankZones.length} zones show uniform print patterns (${(prRatio * 100).toFixed(0)}%)`,
      };
    }

    // Mix of both
    return {
      doc_format: 'scanned_mixed',
      confidence: 0.75,
      page_count: 1,
      has_images: true,
      format_detail: `Scanned mixed — ${handwrittenZones} handwritten + ${printedZones} printed zones detected`,
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
      issues.push(`Low DPI (~${estimated_dpi}) — text may be blurry`);
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
      issues.push('Low contrast — text may be faint');
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
      issues.push(`Resolution too small (${width}x${height})`);
      if (!recommended_steps.includes('upscale')) recommended_steps.push('upscale');
      quality_score -= 0.15;
    }

    if (is_color) recommended_steps.push('grayscale');

    const aspectRatio = width / height;
    if (aspectRatio > 1.6 || aspectRatio < 0.4) {
      issues.push('Unusual aspect ratio — may be rotated or skewed');
      recommended_steps.push('deskew');
      quality_score -= 0.10;
    }

    void info;
    void stdDev;

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
// LAYER 3 — Format-Aware Adaptive Preprocessor
// Different preprocessing pipelines per document format
// ─────────────────────────────────────────────────────────────

export async function preprocessImage(
  buffer: Buffer,
  steps: PreprocessStep[],
  docFormat?: DocFormat,
  targetMime: 'image/png' | 'image/jpeg' = 'image/png'
): Promise<PreprocessResult> {
  const steps_applied: PreprocessStep[] = [];

  // Override steps based on doc format for best results
  let effectiveSteps = [...steps];

  if (docFormat === 'scanned_handwritten') {
    // Handwriting needs: grayscale + upscale + adaptive threshold + stroke enhance
    effectiveSteps = ['grayscale', 'upscale', 'normalize', 'sharpen', 'adaptive_threshold'];
  } else if (docFormat === 'faxed') {
    // Fax needs: heavy denoise + binarize + upscale
    effectiveSteps = ['grayscale', 'denoise', 'upscale', 'binarize'];
  } else if (docFormat === 'photographed') {
    // Photo needs: CLAHE + normalize + upscale
    effectiveSteps = ['grayscale', 'clahe', 'normalize', 'upscale', 'sharpen'];
  } else if (docFormat === 'scanned_mixed') {
    // Mixed needs: denoise + normalize + mild upscale
    effectiveSteps = ['grayscale', 'denoise', 'normalize', 'upscale'];
  } else if (docFormat === 'scanned_digital') {
    // Scanned digital: normalize + denoise
    effectiveSteps = ['grayscale', 'normalize', 'denoise'];
  }

  let pipeline = sharp(buffer);

  if (effectiveSteps.includes('grayscale')) {
    pipeline = pipeline.grayscale();
    steps_applied.push('grayscale');
  }

  if (effectiveSteps.includes('normalize')) {
    pipeline = pipeline.normalize();
    steps_applied.push('normalize');
  }

  if (effectiveSteps.includes('clahe')) {
    pipeline = pipeline.normalise({ lower: 1, upper: 99 }).linear(1.3, -20);
    steps_applied.push('clahe');
  }

  if (effectiveSteps.includes('denoise')) {
    pipeline = pipeline.median(3).sharpen({ sigma: 0.5 });
    steps_applied.push('denoise');
  }

  if (effectiveSteps.includes('sharpen') && !steps_applied.includes('denoise')) {
    pipeline = pipeline.sharpen({ sigma: 1.2, m1: 2.0, m2: 0.5 });
    steps_applied.push('sharpen');
  }

  if (effectiveSteps.includes('upscale')) {
    const meta = await sharp(buffer).metadata();
    const w = meta.width ?? 800;
    if (w < 1700) {
      // For handwriting, scale up more aggressively
      const targetWidth = docFormat === 'scanned_handwritten' ? 2400 : 1700;
      const scaleFactor = Math.min(3.0, targetWidth / w);
      pipeline = pipeline.resize({
        width: Math.round(w * scaleFactor),
        kernel: sharp.kernel.lanczos3,
      });
      steps_applied.push('upscale');
    }
  }

  if (effectiveSteps.includes('adaptive_threshold')) {
    // Approximate adaptive threshold: normalize + high contrast linear
    // True adaptive threshold needs OpenCV — this is a good approximation
    pipeline = pipeline
      .normalise({ lower: 2, upper: 98 })
      .linear(1.8, -40)
      .threshold(160);
    steps_applied.push('adaptive_threshold');
  }

  if (effectiveSteps.includes('binarize') && !steps_applied.includes('adaptive_threshold')) {
    pipeline = pipeline.threshold(128);
    steps_applied.push('binarize');
  }

  if (effectiveSteps.includes('deskew')) {
    pipeline = pipeline.rotate(0, { background: { r: 255, g: 255, b: 255, alpha: 1 } });
    steps_applied.push('deskew');
  }

  // Cap at 2400px for Claude Vision
  const preFinalMeta = await pipeline.clone().metadata();
  if ((preFinalMeta.width ?? 0) > 2400) {
    pipeline = pipeline.resize({ width: 2400, withoutEnlargement: false });
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
  mimeType: string,
  docFormat?: DocFormat
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
  const result = await preprocessImage(buffer, report.recommended_steps, docFormat);
  return { result, report };
}