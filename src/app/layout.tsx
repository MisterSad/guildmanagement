import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "RAD Management",
    template: "%s · RAD Management",
  },
  description:
    "Guild operations tool for Foundation Galactic Frontier — events, members, stats and sanctions.",
  applicationName: "RAD Management",
  robots: { index: false, follow: false },
  formatDetection: { telephone: false, email: false, address: false },
  icons: { icon: "/favicon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0b0f19",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="bg-zinc-950 text-zinc-100 min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}
