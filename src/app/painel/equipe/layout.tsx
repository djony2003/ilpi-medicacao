"use client";

import type { ReactNode } from "react";
import { SoParaGestao } from "../contexto";

export default function LayoutSoGestao({ children }: { children: ReactNode }) {
  return <SoParaGestao>{children}</SoParaGestao>;
}
