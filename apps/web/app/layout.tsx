import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Toaster } from 'sonner';
import { ThemeProvider } from '@/components/theme-provider';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'QuantSignal',
  description: '글로벌 선행 신호를 한국 관심종목 단위로 번역하는 AI 투자 판단 보조 시스템',
};

/**
 * Inline theme bootstrap — runs synchronously before React hydrates so the
 * very first paint already reflects the user's saved preference. Without
 * this the server renders `data-theme="dark"`, the useEffect kicks in after
 * paint, and users with light-mode in localStorage see a dark→light flash
 * (FOUC). The IIFE is tiny (<200 bytes) and dangerouslySetInnerHTML is safe
 * here — no user input touches it.
 */
const THEME_BOOTSTRAP = `
(function(){
  try {
    var t = localStorage.getItem('qs.theme');
    if (t !== 'light' && t !== 'dark') t = 'dark';
    document.documentElement.setAttribute('data-theme', t);
  } catch(e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className={`${inter.variable} font-body antialiased`}>
        <ThemeProvider>{children}</ThemeProvider>
        <Toaster position="top-right" theme="dark" />
      </body>
    </html>
  );
}
