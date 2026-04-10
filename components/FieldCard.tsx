// components/FieldCard.tsx
// Displays a single extracted field with confidence color coding

import { ValidatedField } from '@/lib/validator';

interface FieldCardProps {
  fieldKey: string;
  field: ValidatedField;
}

function formatKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function formatValue(value: ValidatedField['value']): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  return String(value);
}

export default function FieldCard({ fieldKey, field }: FieldCardProps) {
  const { value, confidence, valid, reason } = field;

  const colors = {
    high:   { border: 'border-green-700',  badge: 'bg-green-900 text-green-300',  dot: 'bg-green-400'  },
    medium: { border: 'border-yellow-700', badge: 'bg-yellow-900 text-yellow-300', dot: 'bg-yellow-400' },
    low:    { border: 'border-red-700',    badge: 'bg-red-900 text-red-300',       dot: 'bg-red-400'    },
  };

  const scheme = colors[confidence];
  const displayValue = formatValue(value);

  return (
    <div className={`rounded-xl border ${scheme.border} bg-gray-900 p-4 flex flex-col gap-2`}>
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-gray-400 text-xs font-medium uppercase tracking-wide truncate">
          {formatKey(fieldKey)}
        </span>
        <span className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${scheme.badge} shrink-0`}>
          <span className={`w-1.5 h-1.5 rounded-full ${scheme.dot}`} />
          {confidence}
        </span>
      </div>

      {/* Value */}
      <p className={`text-sm font-mono break-all ${valid ? 'text-white' : 'text-gray-400 line-through'}`}>
        {displayValue}
      </p>

      {/* Reason (shown when invalid or medium confidence) */}
      {reason && (
        <p className="text-xs text-gray-500 italic">{reason}</p>
      )}
    </div>
  );
}