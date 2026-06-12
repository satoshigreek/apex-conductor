import type { Metadata } from "next";
import Link from "next/link";
import { IBM_Plex_Mono, IBM_Plex_Sans, Rajdhani } from "next/font/google";
import "./globals.css";

const rajdhani = Rajdhani({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-rajdhani" });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
  title: "Apex Conductor",
  description: "Orchestrate the Vector agent network. Pay in USDC, settle in AP3X.",
};

const NAV = [
  { href: "/", label: "Conductor" },
  { href: "/refuel", label: "Refuel" },
  { href: "/agents", label: "Agents" },
  { href: "/tasks", label: "Tasks" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${rajdhani.variable} ${plexSans.variable} ${plexMono.variable} font-body min-h-screen`}>
        <header className="border-b border-line sticky top-0 bg-void/85 backdrop-blur z-20">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="font-display font-bold text-xl tracking-wide uppercase">Apex</span>
              <span className="font-display font-medium text-xl tracking-wide uppercase text-gold">Conductor</span>
            </Link>
            <nav className="flex gap-6">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="font-mono text-xs uppercase tracking-[0.18em] text-ink-3 hover:text-gold transition">
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-6 py-10">{children}</main>
        <footer className="border-t border-line mt-20">
          <div className="max-w-6xl mx-auto px-6 py-6 eyebrow flex justify-between">
            <span>Vector network · testnet until M5 gate</span>
            <span>every task = escrow + fees + anchor, all in AP3X</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
