// components/UploadZone.tsx
// Drag and drop file upload zone

'use client';

import { useRef, useState } from 'react';

interface UploadZoneProps {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

const ACCEPTED = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
  'image/bmp',
  'image/heic',
];

const ACCEPTED_EXT = '.pdf,.jpg,.jpeg,.png,.tif,.tiff,.webp,.bmp,.heic';

const DOC_TYPES = [
  'CMS-1500', 'UB-04', 'EOB', 'ERA',
  'Prior Auth', 'Denial Letter', 'Insurance Card',
  'Clinical Note', 'Discharge Summary', 'Anesthesia Record',
  'Anesthesia Demographics', 'Operative Report', 'Referral Letter',
  'Handwritten Note',
];

export default function UploadZone({ onFileSelected, disabled }: UploadZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File) {
    setError('');
    if (!ACCEPTED.includes(file.type) && !file.name.toLowerCase().endsWith('.heic')) {
      setError(`Unsupported file type: ${file.type || file.name.split('.').pop()}`);
      return;
    }
    const maxMb = 20;
    if (file.size > maxMb * 1024 * 1024) {
      setError(`File too large. Maximum size is ${maxMb}MB.`);
      return;
    }
    setSelectedFile(file);
    onFileSelected(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Drop zone */}
      <div
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`
          relative rounded-2xl border-2 border-dashed p-8 text-center cursor-pointer transition-all
          ${disabled ? 'opacity-50 cursor-not-allowed border-gray-700' :
            dragOver ? 'border-blue-400 bg-blue-950/30' :
            selectedFile ? 'border-green-600 bg-green-950/20' :
            'border-gray-700 hover:border-gray-500 bg-gray-900/50'}
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXT}
          onChange={onInputChange}
          className="hidden"
          disabled={disabled}
        />

        {selectedFile ? (
          <div className="flex flex-col items-center gap-2">
            <span className="text-3xl">📄</span>
            <p className="text-white font-medium text-sm">{selectedFile.name}</p>
            <p className="text-gray-400 text-xs">{formatSize(selectedFile.size)}</p>
            {!disabled && (
              <p className="text-gray-500 text-xs mt-1">Click to change file</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <span className="text-4xl">⬆️</span>
            <p className="text-white font-medium">Drop your document here</p>
            <p className="text-gray-400 text-sm">or click to browse</p>
            <p className="text-gray-600 text-xs mt-1">
              PDF · JPG · PNG · TIFF · WEBP · BMP · HEIC — max 20MB
            </p>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <p className="text-red-400 text-sm">{error}</p>
      )}

      {/* Document type tags */}
      <div className="flex flex-col gap-2">
        <p className="text-gray-500 text-xs uppercase tracking-wide">Supported document types</p>
        <div className="flex flex-wrap gap-1.5">
          {DOC_TYPES.map(type => (
            <span
              key={type}
              className="px-2 py-1 rounded-md bg-gray-800 text-gray-400 text-xs border border-gray-700"
            >
              {type}
            </span>
          ))}
        </div>
      </div>

    </div>
  );
}