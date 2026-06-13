import type { Metadata } from "next";
import Link from "next/link";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const grotesk = Space_Grotesk({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700"], variable: "--font-grotesk" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: "Apex Conductor",
  description: "Orchestrate the Vector agent network. Pay in USDC, settle in AP3X.",
};

const NAV = [
  { href: "/", label: "Conductor" },
  { href: "/refuel", label: "Refuel" },
  { href: "/agents", label: "Agents" },
  { href: "/clients", label: "Clients" },
  { href: "/tasks", label: "Tasks" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${grotesk.variable} ${jetbrains.variable} font-body min-h-screen`}>
        <header className="border-b border-line sticky top-0 bg-void/85 backdrop-blur z-20">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-baseline justify-between">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="font-display font-bold text-xl tracking-[-0.04em] uppercase">Apex</span>
              <span className="font-display font-light text-xl tracking-[-0.02em] uppercase text-accent">Conductor</span>
            </Link>
            <nav className="flex gap-6">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="font-mono text-xs uppercase tracking-[0.18em] text-ink-3 hover:text-accent transition">
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
