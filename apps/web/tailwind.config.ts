import type { Config } from "tailwindcss";

/** AP3X Fusion design system (style guide) — dark emerald paper, ember/emerald accents. */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#07100C", // paper
        panel: "#0E1B16", // paper-2
        panel2: "#15281F", // paper-3
        line: "#1F3A30", // rule
        line2: "#132720", // rule-2
        accent: "#D9583E", // ember
        accent2: "#4BB87A", // emerald
        emeraldsoft: "#7FD5A1",
        ink: "#EAF3EC",
        "ink-2": "#B8CDBF",
        "ink-3": "#7A9285",
        "ink-4": "#4D6459",
        good: "#4BB87A",
        warn: "#F2A03C", // ignition
      },
      fontFamily: {
        display: ["var(--font-grotesk)", "ui-sans-serif", "sans-serif"],
        body: ["var(--font-grotesk)", "ui-sans-serif", "sans-serif"],
        mono: ["var(--font-jetbrains)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
