import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TwinPass · Edge Verification Center",
  description: "A multimodal Edge AI attendance dashboard powered by Vision and Voice",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko" data-scroll-behavior="smooth"><body>{children}</body></html>;
}
