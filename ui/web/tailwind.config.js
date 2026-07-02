/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "app-bg": "var(--app-bg)",
        panel: "var(--panel)",
        border: "var(--border)",
        hover: "var(--hover)",
        chip: "var(--chip)",
        fg: "var(--fg)",
        fg2: "var(--fg2)",
        muted: "var(--muted)",
        accent: "var(--accent)",
        "accent-hi": "var(--accent-hi)",
        "accent-fg": "var(--accent-fg)",
        "accent-soft": "var(--accent-soft)",
        "accent-border": "var(--accent-border)",
        "accent-glow": "var(--accent-glow)",
        ok: "var(--ok)",
        "ok-soft": "var(--ok-soft)",
        "ok-border": "var(--ok-border)",
        warn: "var(--warn)",
        "warn-soft": "var(--warn-soft)",
        err: "var(--err)",
        done: "var(--done)",
        "done-soft": "var(--done-soft)",
        "node-bg": "var(--node-bg)",
        "node-border": "var(--node-border)",
        edge: "var(--edge)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "-apple-system", "SF Pro Text", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        panel: "var(--shadow)",
      },
      transitionTimingFunction: {
        smooth: "cubic-bezier(.2, .7, .3, 1)",
      },
      keyframes: {
        pulse2: {
          "0%,100%": { transform: "scale(.8)", opacity: ".7" },
          "50%": { transform: "scale(1.25)", opacity: "1" },
        },
        ping2: {
          "0%": { boxShadow: "0 0 0 0 var(--ok)" },
          "70%": { boxShadow: "0 0 0 5px transparent" },
          "100%": { boxShadow: "0 0 0 0 transparent" },
        },
        dash: {
          to: { strokeDashoffset: "-24" },
        },
        slidein: {
          from: { opacity: "0", transform: "translateX(7px)" },
          to: { opacity: "1", transform: "none" },
        },
        floaty: {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-2.5px)" },
        },
        fadein: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        gdotpulse: {
          "0%,100%": { opacity: ".55" },
          "50%": { opacity: "1" },
        },
        gdotwait: {
          "0%,100%": { opacity: ".3" },
          "50%": { opacity: ".75" },
        },
        gdothalo: {
          "0%": { opacity: ".4", transform: "scale(1)" },
          "70%,100%": { opacity: "0", transform: "scale(2.6)" },
        },
        activityIn: {
          from: { opacity: "0", transform: "translateY(-5px)" },
          to: { opacity: "1", transform: "none" },
        },
      },
      animation: {
        activityIn: "activityIn .24s cubic-bezier(.2,.7,.3,1)",
        pulse13: "pulse2 1.3s infinite",
        pulse2: "pulse2 1.4s infinite",
        ping2: "ping2 1.6s infinite",
        dash: "dash 1s linear infinite",
        slidein: "slidein .2s ease",
        floaty: "floaty 3s ease-in-out infinite",
        fadein: "fadein .2s ease",
        gdotpulse: "gdotpulse 1.6s ease-in-out infinite",
        gdotwait: "gdotwait 2.6s ease-in-out infinite",
        gdothalo: "gdothalo 1.6s ease-out infinite",
      },
    },
  },
  plugins: [],
};
