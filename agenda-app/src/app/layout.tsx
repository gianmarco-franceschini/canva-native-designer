import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Agenda aziendale",
  description: "Agenda interna per appuntamenti e riunioni",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // La CSP del middleware usa un nonce per richiesta (header `x-nonce`): leggere gli header
  // rende ogni pagina dinamica, così Next applica il nonce ai propri script. Eventuali
  // <Script> di terze parti dovranno ricevere `(await headers()).get("x-nonce")`.
  await headers();
  return (
    <html lang="it">
      <body className={`${inter.variable} antialiased`}>{children}</body>
    </html>
  );
}
