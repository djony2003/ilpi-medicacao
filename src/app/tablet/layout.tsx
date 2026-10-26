import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Tablet do posto | ILPI Medicação",
  manifest: "/tablet.webmanifest",
  robots: { index: false, follow: false },
};

// Sem zoom por gesto (o modo quiosque não deve sair do lugar com um toque duplo de luva); o
// tamanho da letra já é grande por desenho.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#14283A",
};

export default function LayoutDoTablet({ children }: { children: ReactNode }) {
  return children;
}
