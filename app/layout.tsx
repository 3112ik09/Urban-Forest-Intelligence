import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Delhi Urban Forest Intelligence',
  description: 'Real-time satellite canopy analysis for Delhi districts — powered by Gemma 4',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
