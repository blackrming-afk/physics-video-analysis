import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Physics Video Analysis",
  description: "Browser-based local video analysis workspace for physics learning.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body className="antialiased">{children}</body>
    </html>
  );
}
