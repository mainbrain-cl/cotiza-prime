import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { EnvBanner } from "@/components/env-banner";
import { Toaster } from "@/components/ui/toaster";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cotiza Prime",
  description: "Cotiza en minutos, con tu marca, sin perder el control.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Necesario para que env(safe-area-inset-*) tenga valor en teléfonos con muesca
  viewportFit: "cover",
  colorScheme: "light dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-CL" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <EnvBanner />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
