import type { ReactNode } from "react";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./_comum/interface.css";

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
