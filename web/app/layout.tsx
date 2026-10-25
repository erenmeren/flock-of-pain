import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { TwinProvider } from "@/lib/store";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Workforce Twin",
  description: "Simulate. Understand. Build.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}>
      <body className="flex h-full min-h-screen gap-3 p-3">
        <TwinProvider>
          <Suspense><Sidebar /></Suspense>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <Suspense><Topbar /></Suspense>
            <main className="min-h-0 flex-1 overflow-auto rounded-2xl p-1">{children}</main>
          </div>
        </TwinProvider>
      </body>
    </html>
  );
}
