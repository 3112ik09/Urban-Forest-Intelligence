import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Urban Forest Intelligence',
  description: 'Real-time satellite canopy analysis for any city — powered by Gemma 4',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
