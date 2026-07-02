/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── "Soft Signal / Dusk" semantic tokens (preferred names) ──
        bg: "var(--bg)",
        surface: "var(--surface)",
        surface2: "var(--surface2)",
        raise: "var(--raise)",
        well: "var(--well)",
        line: "var(--line)",
        line2: "var(--line2)",
        ink: "var(--ink)",
        "ink-dim": "var(--ink-dim)",
        "ink-dimmer": "var(--ink-dimmer)",
        brand: "var(--brand)",
        "brand-bg": "var(--brand-bg)",
        run: "var(--run)",
        "run-soft": "var(--run-soft)",
        done: "var(--done)",
        "done-soft": "var(--done-soft)",
        wait: "var(--wait)",
        warn: "var(--warn)",
        "warn-soft": "var(--warn-soft)",
        crit: "var(--crit)",
        "crit-soft": "var(--crit-soft)",

        // ── legacy aliases (old class names still used across components) ──
        // Kept pointing at the new palette so the app reskins instantly; markup
        // is migrated to the semantic names above phase by phase.
        "app-bg": "var(--bg)",
        panel: "var(--surface)",
        border: "var(--line)",
        hover: "var(--raise)",
        chip: "var(--well)",
        fg: "var(--ink)",
        fg2: "var(--ink-dim)",
        muted: "var(--ink-dimmer)",
        accent: "var(--brand)",
        "accent-hi": "var(--brand)",
        "accent-fg": "var(--brand)",
        "accent-soft": "var(--brand-bg)",
        "accent-border": "color-mix(in srgb, var(--brand) 45%, var(--line))",
        "accent-glow": "color-mix(in srgb, var(--brand) 40%, transparent)",
        ok: "var(--done)",
        "ok-soft": "var(--done-soft)",
        "ok-border": "color-mix(in srgb, var(--done) 45%, var(--line))",
        err: "var(--crit)",
        "node-bg": "var(--surface)",
        "node-border": "var(--line)",
        edge: "var(--line2)",
      },
      fontFamily: {
        sans: ['"Hanken Grotesk"', "system-ui", "-apple-system", "sans-serif"],
        mono: ['"DM Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        panel: "var(--shadow)",
      },
      backgroundImage: {
        panel: "var(--panel-grad)",
      },
      transitionTimingFunction: {
        smooth: "cubic-bezier(.2, .7, .3, 1)",
      },
      keyframes: {
        // ── design-spec motion vocabulary ──
        flow: { to: { strokeDashoffset: "-16" } },
        softblink: { "0%,100%": { opacity: "1" }, "50%": { opacity: ".35" } },
        halo: {
          "0%": { transform: "scale(1)", opacity: ".55" },
          "70%,100%": { transform: "scale(2.2)", opacity: "0" },
        },
        feedin: {
          from: { opacity: "0", transform: "translateY(-6px)" },
          to: { opacity: "1", transform: "none" },
        },
        // ── retained (used by existing components) ──
        pulse2: {
          "0%,100%": { transform: "scale(.8)", opacity: ".7" },
          "50%": { transform: "scale(1.25)", opacity: "1" },
        },
        ping2: {
          "0%": { boxShadow: "0 0 0 0 var(--run)" },
          "70%": { boxShadow: "0 0 0 5px transparent" },
          "100%": { boxShadow: "0 0 0 0 transparent" },
        },
        dash: { to: { strokeDashoffset: "-16" } },
        slidein: {
          from: { opacity: "0", transform: "translateX(7px)" },
          to: { opacity: "1", transform: "none" },
        },
        floaty: {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-2.5px)" },
        },
        fadein: { from: { opacity: "0" }, to: { opacity: "1" } },
        gdotpulse: { "0%,100%": { opacity: ".55" }, "50%": { opacity: "1" } },
        gdotwait: { "0%,100%": { opacity: ".3" }, "50%": { opacity: ".75" } },
        gdothalo: {
          "0%": { opacity: ".55", transform: "scale(1)" },
          "70%,100%": { opacity: "0", transform: "scale(2.2)" },
        },
        activityIn: {
          from: { opacity: "0", transform: "translateY(-6px)" },
          to: { opacity: "1", transform: "none" },
        },
      },
      animation: {
        flow: "flow 1.1s linear infinite",
        softblink: "softblink 2.6s ease-in-out infinite",
        "softblink-fast": "softblink 1.6s ease-in-out infinite",
        halo: "halo 2.2s ease-in-out infinite",
        feedin: "feedin .35s ease",
        activityIn: "feedin .35s ease",
        pulse13: "pulse2 1.3s infinite",
        pulse2: "pulse2 1.4s infinite",
        ping2: "ping2 1.6s infinite",
        dash: "flow 1.1s linear infinite",
        slidein: "slidein .2s ease",
        floaty: "floaty 3s ease-in-out infinite",
        fadein: "fadein .2s ease",
        gdotpulse: "gdotpulse 1.6s ease-in-out infinite",
        gdotwait: "gdotwait 2.6s ease-in-out infinite",
        gdothalo: "halo 2.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
