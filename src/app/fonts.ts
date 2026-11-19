import { Geist, Geist_Mono } from "next/font/google";

/** Las tipografías de la aplicación; las usan el diseño raíz y la pantalla de error global (que lo reemplaza). */
export const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

export const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});
