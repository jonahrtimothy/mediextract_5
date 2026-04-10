import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MediExtract — Healthcare Document Intelligence',
  description: 'Production-grade healthcare OCR pipeline that beats UiPath Document Understanding',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 antialiased">
        {children}
      </body>
    </html>
  );
}