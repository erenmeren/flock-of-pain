import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { ConfirmProvider } from "@/lib/confirm";
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
      <body className="h-full min-h-screen p-3">
        {/* popups portal into <body>; the flex row lives one level down so their containers do not take a gap */}
        <div className="flex h-full gap-3">
          <ConfirmProvider><TwinProvider>
            <Suspense><Sidebar className="hidden lg:flex" /></Suspense>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <Suspense><Topbar /></Suspense>
              <main className="min-h-0 flex-1 overflow-auto rounded-2xl p-1">{children}</main>
            </div>
          </TwinProvider></ConfirmProvider>
        </div>
      </body>
    </html>
  );
}
