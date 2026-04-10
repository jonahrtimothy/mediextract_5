'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import UploadZone from '@/components/UploadZone';
import PipelineSteps, { buildSteps, PipelineData } from '@/components/PipelineSteps';
import FieldCard from '@/components/FieldCard';
import { ValidatedField } from '@/lib/validator';

interface PipelineResult {
  pipeline: PipelineData & {
    file_name: string;
    file_size_kb: number;
    processing_time_ms: number;
    quality_issues: string[];
  };
  fields: Record<string, ValidatedField>;
  flags: string[];
  raw_text: string;
}

type ProcessingState = 'idle' | 'processing' | 'done' | 'error';

export default function DemoPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<ProcessingState>('idle');
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [activeTab, setActiveTab] = useState<'ocr' | 'architecture'>('ocr');

  // Auth guard
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const auth = sessionStorage.getItem('mediextract_auth');
      if (!auth) router.push('/');
    }
  }, [router]);

  async function handleProcess() {
    if (!file) return;
    setState('processing');
    setResult(null);
    setErrorMsg('');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/process', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Pipeline failed');
      }

      setResult(data);
      setState('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setState('error');
    }
  }

  const steps = buildSteps(
    result?.pipeline ?? {},
    state === 'done' ? 'done' : state === 'error' ? 'error' : 'processing'
  );

  const fieldEntries = result
    ? Object.entries(result.fields)
    : [];

  const highFields   = fieldEntries.filter(([, f]) => f.confidence === 'high' && f.valid);
  const mediumFields = fieldEntries.filter(([, f]) => f.confidence === 'medium');
  const lowFields    = fieldEntries.filter(([, f]) => f.confidence === 'low' || !f.valid);

  function formatDocType(t: string) {
    return t.replace(/_/g, ' ').toUpperCase();
  }

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">

      {/* Top nav */}
      <nav className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-sm font-bold">M</div>
          <span className="font-semibold text-white">MediExtract_5</span>
          <span className="text-gray-600 text-sm">v1.0</span>
        </div>
        <div className="flex gap-1">
          {(['ocr', 'architecture'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                activeTab === tab
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab === 'ocr' ? 'Healthcare RCM OCR' : 'Pipeline Architecture'}
            </button>
          ))}
        </div>
        <button
          onClick={() => { sessionStorage.removeItem('mediextract_auth'); router.push('/'); }}
          className="text-gray-600 hover:text-gray-400 text-sm transition"
        >
          Sign out
        </button>
      </nav>

      {/* OCR Tab */}
      {activeTab === 'ocr' && (
        <div className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-2 gap-8">

          {/* LEFT — Upload panel */}
          <div className="flex flex-col gap-6">
            <div>
              <h1 className="text-2xl font-bold text-white">Document Intelligence</h1>
              <p className="text-gray-400 mt-1 text-sm">
                Upload any healthcare document. The 5-layer pipeline detects, enhances, extracts, and validates every field.
              </p>
            </div>

            <UploadZone
              onFileSelected={setFile}
              disabled={state === 'processing'}
            />

            <button
              onClick={handleProcess}
              disabled={!file || state === 'processing'}
              className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 text-white font-semibold transition text-sm"
            >
              {state === 'processing' ? 'Processing...' : 'Run 5-Layer Pipeline →'}
            </button>

            {/* Pipeline steps */}
            {state !== 'idle' && (
              <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
                <h2 className="text-white font-semibold text-sm mb-4">Pipeline Execution</h2>
                <PipelineSteps steps={steps} />

                {/* Timing */}
                {result && (
                  <div className="mt-4 pt-4 border-t border-gray-800 flex flex-wrap gap-4 text-xs text-gray-500">
                    <span>⏱ {result.pipeline.processing_time_ms}ms</span>
                    <span>📄 {result.pipeline.file_name}</span>
                    <span>💾 {result.pipeline.file_size_kb} KB</span>
                  </div>
                )}
              </div>
            )}

            {/* Error */}
            {state === 'error' && (
              <div className="bg-red-950 border border-red-800 rounded-xl p-4 text-red-300 text-sm">
                {errorMsg}
              </div>
            )}
          </div>

          {/* RIGHT — Results panel */}
          <div className="flex flex-col gap-6">

            {state === 'idle' && (
              <div className="flex flex-col items-center justify-center h-64 text-center text-gray-600">
                <p className="text-4xl mb-3">🏥</p>
                <p className="text-sm">Upload a document and run the pipeline to see extracted fields here.</p>
              </div>
            )}

            {state === 'processing' && (
              <div className="flex flex-col items-center justify-center h-64 text-center text-gray-500">
                <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
                <p className="text-sm">Analyzing document with Claude Vision...</p>
              </div>
            )}

            {state === 'done' && result && (
              <>
                {/* Summary bar */}
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h2 className="text-white font-semibold">
                        {formatDocType(result.pipeline.doc_type ?? 'unknown')}
                      </h2>
                      <p className="text-gray-500 text-xs mt-0.5">
                        {result.pipeline.doc_format} · quality {((result.pipeline.quality_score ?? 0) * 100).toFixed(0)}%
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold text-white">
                        {((result.pipeline.overall_confidence ?? 0) * 100).toFixed(0)}%
                      </p>
                      <p className="text-gray-500 text-xs">overall confidence</p>
                    </div>
                  </div>
                  <div className="flex gap-4 text-xs">
                    <span className="text-green-400">✓ {result.pipeline.validated_count} valid</span>
                    <span className="text-red-400">✕ {result.pipeline.failed_count} failed</span>
                    <span className="text-yellow-400">⚠ {result.pipeline.warning_count} warnings</span>
                  </div>
                </div>

                {/* Flags */}
                {result.flags.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-gray-400 text-xs uppercase tracking-wide font-medium">Billing Flags</h3>
                    {result.flags.map((flag, i) => (
                      <div key={i} className="bg-yellow-950 border border-yellow-800 rounded-xl px-4 py-2.5 text-yellow-300 text-sm">
                        ⚠ {flag}
                      </div>
                    ))}
                  </div>
                )}

                {/* Fields — high confidence */}
                {highFields.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-gray-400 text-xs uppercase tracking-wide font-medium">Validated Fields</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {highFields.map(([key, field]) => (
                        <FieldCard key={key} fieldKey={key} field={field} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Fields — medium confidence */}
                {mediumFields.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-gray-400 text-xs uppercase tracking-wide font-medium">Review Required</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {mediumFields.map(([key, field]) => (
                        <FieldCard key={key} fieldKey={key} field={field} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Fields — low confidence / failed */}
                {lowFields.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-gray-400 text-xs uppercase tracking-wide font-medium">Failed Validation</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {lowFields.map(([key, field]) => (
                        <FieldCard key={key} fieldKey={key} field={field} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Raw text toggle */}
                <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
                  <button
                    onClick={() => setShowRaw(r => !r)}
                    className="w-full px-5 py-3 text-left text-gray-400 text-sm flex items-center justify-between hover:text-white transition"
                  >
                    <span>Raw extracted text</span>
                    <span>{showRaw ? '▲' : '▼'}</span>
                  </button>
                  {showRaw && (
                    <pre className="px-5 pb-5 text-xs text-gray-500 whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">
                      {result.raw_text}
                    </pre>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Architecture Tab */}
      {activeTab === 'architecture' && (
        <div className="max-w-3xl mx-auto px-6 py-12 flex flex-col gap-6">
          <h1 className="text-2xl font-bold text-white">5-Layer Pipeline Architecture</h1>
          <p className="text-gray-400 text-sm">
            MediExtract reads meaning — not layout. When a payer changes their prior auth form design,
            UiPath breaks and needs retraining. MediExtract reads the same — it understands what a
            member ID is, not where it appears on the page.
          </p>

          {[
            { layer: 'Layer 1', title: 'Document Format Detector', color: 'blue',
              desc: 'Classifies the document as digital, scanned, handwritten, photographed, or mixed using pixel statistics and metadata analysis.' },
            { layer: 'Layer 2', title: 'Quality Assessor', color: 'purple',
              desc: 'Measures DPI, noise, contrast, blur, and skew. Outputs a quality score 0.0–1.0 and a list of recommended preprocessing steps.' },
            { layer: 'Layer 3', title: 'Adaptive Preprocessor', color: 'indigo',
              desc: 'Applies only what the quality score demands: deskew, denoise, CLAHE, upscale, binarize, sharpen. Uses sharp for Vercel-compatible image processing.' },
            { layer: 'Layer 4', title: 'Claude Vision Extractor', color: 'cyan',
              desc: 'Two-step process: quick detection call identifies document type, then one of 13 specialist RCM prompts extracts every field as structured JSON.' },
            { layer: 'Layer 5', title: 'Field Validator + Confidence Scorer', color: 'green',
              desc: 'Validates NPI, ICD-10, CPT, HCPCS, dates, amounts, auth numbers, CARC/RARC codes. Cross-validates dates. Flags billing errors. Scores every field GREEN / AMBER / RED.' },
          ].map(({ layer, title, color, desc }) => (
            <div key={layer} className={`bg-gray-900 border border-${color}-900 rounded-2xl p-6 flex gap-4`}>
              <div className={`shrink-0 w-20 h-20 rounded-xl bg-${color}-950 border border-${color}-800 flex flex-col items-center justify-center text-center`}>
                <span className={`text-${color}-400 text-xs font-bold`}>{layer}</span>
              </div>
              <div>
                <h3 className="text-white font-semibold mb-1">{title}</h3>
                <p className="text-gray-400 text-sm">{desc}</p>
              </div>
            </div>
          ))}

          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
            <h3 className="text-white font-semibold mb-3">vs. UiPath Document Understanding</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              {[
                ['Layout dependent', 'Semantic understanding'],
                ['Breaks on form redesign', 'Zero-shot — works on any layout'],
                ['100s of labeled samples', 'No training data needed'],
                ['One model per form type', '13 universal RCM prompts'],
                ['No medical knowledge', 'Deep clinical domain context'],
                ['Enterprise licensing cost', 'Near-zero API cost at scale'],
              ].map(([bad, good], i) => (
                <div key={i} className="contents">
                  <div className="bg-red-950/40 border border-red-900 rounded-lg px-3 py-2 text-red-300">✕ {bad}</div>
                  <div className="bg-green-950/40 border border-green-900 rounded-lg px-3 py-2 text-green-300">✓ {good}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}