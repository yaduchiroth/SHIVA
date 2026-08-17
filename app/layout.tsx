import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'SHIVA',
  description: 'Industrial spatial computing interface — personal agentic AI.',
  applicationName: 'SHIVA',
}

export const viewport: Viewport = {
  themeColor: '#060607',
  width: 'device-width',
  initialScale: 1,
  // The OS occupies the full viewport and handles its own gestures; letting the
  // browser zoom would break the correspondence between hand and cursor.
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
