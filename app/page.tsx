'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LandingPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (password === process.env.NEXT_PUBLIC_DEMO_PASSWORD) {
      sessionStorage.setItem('mediextract_auth', 'true');
      router.push('/demo');
    } else {
      setError('Incorrect password. Please try again.');
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4">

      {/* Logo / Title */}
      <div className="mb-10 text-center">
        <div className="flex items-center justify-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-xl bg-blue-600 flex items-center justify-center text-2xl font-bold">
            M
          </div>
          <h1 className="text-4xl font-bold text-white tracking-tight">
            MediExtract_5
          </h1>
        </div>
        <p className="text-gray-400 text-lg max-w-md">
          Production-grade healthcare document intelligence.
          5-layer OCR pipeline powered by Claude Vision.
        </p>
      </div>

      {/* Feature pills */}
      <div className="flex flex-wrap gap-2 justify-center mb-10">
        {[
          '13 RCM Document Types',
          'CMS-1500 · UB-04 · EOB',
          'Prior Auth · Denial Letters',
          'ICD-10 · CPT · HCPCS Validation',
          'Handwritten + Scanned + Digital',
        ].map((pill) => (
          <span
            key={pill}
            className="px-3 py-1 rounded-full bg-blue-950 text-blue-300 text-sm border border-blue-800"
          >
            {pill}
          </span>
        ))}
      </div>

      {/* Password card */}
      <div className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-2xl p-8">
        <h2 className="text-white font-semibold text-lg mb-1">Demo Access</h2>
        <p className="text-gray-500 text-sm mb-6">Enter the demo password to continue.</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 rounded-lg bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition"
            autoFocus
          />

          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || password.length === 0}
            className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold transition"
          >
            {loading ? 'Entering...' : 'Enter Demo →'}
          </button>
        </form>
      </div>

      {/* Footer */}
      <p className="mt-10 text-gray-600 text-sm">
        Built by Anitha Balasubramanium · MediExtract_5 v1.0 · Powered by Claude Vision API
      </p>

    </main>
  );
}