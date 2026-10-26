import type { ReactNode } from "react";

export const metadata = {
  title: "ILPI Medicação",
  description: "Controle seguro de medicação para casas de idosos",
};

export default function LayoutRaiz({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
