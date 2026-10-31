import './common.css';
import './globals.css';

import { ThemeProvider } from '~/components/theme-provider';
import { Toaster } from '~/components/ui/sonner';
import { Metadata } from 'next';
import { headers } from 'next/headers';
import { App } from './layout.client';
import { extractServerConfigForClient } from '/configs/client';

// TODO update tdk
export const metadata: Metadata = {
  appleWebApp: {
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: '/icon.png',
    shortcut: '/favicon.ico',
    apple: '/favicon.ico',
  },
  formatDetection: {
    email: false,
    telephone: false,
  },
  other: {
    'App-Config': 'fullscreen=yes,useHistoryState=yes,transition=yes',
  },
};

export default async function RootLayout({
  // Layouts must accept a children prop.
  // This will be populated with nested layouts or pages
  children,
}: {
  children: React.ReactNode;
}) {
  const headersList = await headers();
  const serverConfig = await import('../configs/server').then(
    ({ getServerConfig }) => getServerConfig(),
  );
  const clientConfig = extractServerConfigForClient(serverConfig);

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <App clientConfig={clientConfig}>{children}</App>
        </ThemeProvider>
        <Toaster position="top-center" />
      </body>
    </html>
  );
}
