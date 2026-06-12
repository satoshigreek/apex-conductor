import type { Config } from "tailwindcss";

/** SPEC §5.5 aesthetic tokens — void/panel/line/gold, Rajdhani + IBM Plex. */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#070D1A",
        panel: "#0B1B33",
        line: "#1B3050",
        gold: "#C9A227",
        ink: "#E8EDF6",
        "ink-2": "#9FB0C9",
        "ink-3": "#5E7191",
        good: "#3FB97C",
        warn: "#D97B3E",
      },
      fontFamily: {
        display: ["var(--font-rajdhani)", "sans-serif"],
        body: ["var(--font-plex-sans)", "sans-serif"],
        mono: ["var(--font-plex-mono)", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
