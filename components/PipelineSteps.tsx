// components/PipelineSteps.tsx
// Shows live processing steps with status indicators

interface Step {
  label: string;
  detail: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

interface PipelineStepsProps {
  steps: Step[];
}

function StatusIcon({ status }: { status: Step['status'] }) {
  if (status === 'done') {
    return (
      <span className="w-6 h-6 rounded-full bg-green-900 border border-green-600 flex items-center justify-center text-green-400 text-xs font-bold shrink-0">
        ✓
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="w-6 h-6 rounded-full bg-blue-900 border border-blue-500 flex items-center justify-center shrink-0">
        <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="w-6 h-6 rounded-full bg-red-900 border border-red-600 flex items-center justify-center text-red-400 text-xs font-bold shrink-0">
        ✕
      </span>
    );
  }
  // pending
  return (
    <span className="w-6 h-6 rounded-full bg-gray-800 border border-gray-600 flex items-center justify-center shrink-0">
      <span className="w-2 h-2 rounded-full bg-gray-600" />
    </span>
  );
}

export default function PipelineSteps({ steps }: PipelineStepsProps) {
  return (
    <div className="flex flex-col gap-2">
      {steps.map((step, i) => (
        <div key={i} className="flex items-start gap-3">
          <StatusIcon status={step.status} />
          <div className="flex flex-col min-w-0">
            <span className={`text-sm font-medium ${
              step.status === 'done'    ? 'text-white'      :
              step.status === 'running' ? 'text-blue-300'   :
              step.status === 'error'   ? 'text-red-400'    :
              'text-gray-500'
            }`}>
              {step.label}
            </span>
            {step.detail && (
              <span className="text-xs text-gray-500 truncate">{step.detail}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// HELPER — build steps array from pipeline response
// ─────────────────────────────────────────────────────────────

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
}

export interface PipelineData {
  doc_format?: string;
  quality_score?: number;
  quality_issues?: string[];
  preprocessing_applied?: string[];
  doc_type?: string;
  detection_confidence?: number;
  validated_count?: number;
  failed_count?: number;
  warning_count?: number;
  overall_confidence?: number;
  token_usage?: TokenUsage;
}

export function buildSteps(pipeline: PipelineData, state: 'processing' | 'done' | 'error'): Step[] {
  const isDone = state === 'done';
  const isError = state === 'error';

  const qualityLabel = pipeline.quality_score !== undefined
    ? `Quality ${(pipeline.quality_score * 100).toFixed(0)}% — ${
        pipeline.quality_score >= 0.9 ? 'excellent' :
        pipeline.quality_score >= 0.7 ? 'good' :
        pipeline.quality_score >= 0.5 ? 'fair' : 'poor'
      }`
    : 'Assessing quality...';

  const prepLabel = pipeline.preprocessing_applied?.length
    ? `Applied: ${pipeline.preprocessing_applied.join(', ')}`
    : 'No preprocessing needed';

  const docTypeLabel = pipeline.doc_type
    ? `${pipeline.doc_type.replace(/_/g, ' ').toUpperCase()} (${
        pipeline.detection_confidence !== undefined
          ? (pipeline.detection_confidence * 100).toFixed(0) + '% conf'
          : ''
      })`
    : 'Classifying document...';

  const validLabel = pipeline.validated_count !== undefined
    ? `${pipeline.validated_count} fields valid · ${pipeline.failed_count} failed`
    : 'Validating fields...';

  return [
    {
      label: 'Layer 1 — Format Detection',
      detail: isDone || isError ? (pipeline.doc_format ?? 'detected') : 'Detecting document format...',
      status: isDone ? 'done' : isError ? 'error' : 'running',
    },
    {
      label: 'Layer 2 — Quality Assessment',
      detail: isDone ? qualityLabel : isError ? 'failed' : 'Analyzing image quality...',
      status: isDone ? 'done' : isError ? 'error' : 'running',
    },
    {
      label: 'Layer 3 — Preprocessing',
      detail: isDone ? prepLabel : isError ? 'skipped' : 'Enhancing image...',
      status: isDone ? 'done' : isError ? 'error' : 'running',
    },
    {
      label: 'Layer 4 — Claude Vision',
      detail: isDone ? docTypeLabel : isError ? 'failed' : 'Extracting fields with Claude...',
      status: isDone ? 'done' : isError ? 'error' : 'running',
    },
    {
      label: 'Layer 5 — Validation',
      detail: isDone ? validLabel : isError ? 'failed' : 'Validating extracted fields...',
      status: isDone ? 'done' : isError ? 'error' : 'running',
    },
  ];
}