import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Movie MVP API',
  description: 'Movie recognition backend service',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
