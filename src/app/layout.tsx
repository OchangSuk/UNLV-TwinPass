import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TwinPass · Edge 인증 센터",
  description: "Vision과 Voice 기반 멀티모달 Edge AI 출석 인증 대시보드",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko" data-scroll-behavior="smooth"><body>{children}</body></html>;
}
