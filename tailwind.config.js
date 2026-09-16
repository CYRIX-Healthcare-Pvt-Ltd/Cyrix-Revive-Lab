/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /**
         * Cyrix Healthcare palette — black, red, white, exactly as the
         * logo. No blue anywhere in the chrome.
         *
         *   ink       the black of CYRIX / HEALTH CARE PVT LTD
         *   cyrixRed  the X
         *
         * Black carries structure and primary actions. Red is the single
         * accent, kept meaningful — the X in the wordmark, destructive
         * actions, pending badges, poor scores — so it always signals.
         *
         * Score bands use their own semantic greens and ambers: those
         * communicate performance, not brand, and a red-on-red scale
         * would be unreadable.
         */
        /*
         * Read from CSS variables so one stylesheet can restate the whole
         * ramp for dark mode and every existing bg-ink-50 / text-ink-900 /
         * border-ink-200 follows without being touched. There are around
         * 350 of them across 35 components; adding a dark: variant to each
         * would be 350 chances to miss one, and every future component
         * would have to remember.
         *
         * Channels rather than whole colours, and rgb(... / <alpha-value>)
         * rather than var(--x): the app leans on alpha modifiers in 22
         * places — border-ink-200/70, bg-ink-950/60 — and a variable
         * holding "#d8d9dd" cannot take one.
         */
        ink: {
          50:  'rgb(var(--ink-50) / <alpha-value>)',
          100: 'rgb(var(--ink-100) / <alpha-value>)',
          200: 'rgb(var(--ink-200) / <alpha-value>)',
          300: 'rgb(var(--ink-300) / <alpha-value>)',
          400: 'rgb(var(--ink-400) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          950: 'rgb(var(--ink-950) / <alpha-value>)',
        },
        /** The page behind everything. White in light, near-black in dark. */
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        /** Cards and bars, a step lighter than the canvas in dark so they
         *  still read as raised without needing a shadow. */
        surface: 'rgb(var(--surface) / <alpha-value>)',
        /** Text and icons sitting on an ink-900/950 fill. It cannot be
         *  plain white: ink-900 becomes near-white in dark, and white on
         *  white is the one thing a palette swap must not produce. */
        onInk: 'rgb(var(--on-ink) / <alpha-value>)',
        /**
         * Near-black in both themes, for the surfaces that are meant to be
         * dark rather than merely darker than the page: the sign-in hero,
         * the chatbot's chrome, the analysis cards, and every modal scrim.
         *
         * These were bg-ink-950 and inverting them turned the sign-in hero
         * white while the wordmark on it stayed white — an invisible logo
         * on a blank panel. A scrim is worse: ink-950/60 in dark is a white
         * veil over a dark page, which reads as the screen washing out.
         *
         * Not a token that flips, because these are not "the darkest step
         * of the palette". They are dark on purpose.
         *
         * Exactly #000000, which is what ink-950 rendered before any of
         * this existed. These surfaces must look in light precisely as
         * they always have — near-black would have been a quiet redesign
         * of the sign-in screen smuggled in behind a dark mode.
         */
        shade: 'rgb(0 0 0 / <alpha-value>)',
        /*
         * Status hues, on the same variables for the same reason.
         *
         * Only the ends are variable. 50/100/200 are the washes a status
         * panel sits on and 700/800/900 is the text on them, so both ends
         * have to turn together on a dark page — otherwise deep amber text
         * lands on a pale amber panel that is now the darkest thing on
         * screen, which is how a warning came to read as unstyled grey.
         *
         * 300 to 600 stay literal. They are icons and accents picked to
         * work on either ground, and cyrixRed-600 is the X in the logo:
         * a brand colour that moves with the theme is not one.
         */
        amber: {
          50:  'rgb(var(--amber-50) / <alpha-value>)',
          100: 'rgb(var(--amber-100) / <alpha-value>)',
          200: 'rgb(var(--amber-200) / <alpha-value>)',
          300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706',
          700: 'rgb(var(--amber-700) / <alpha-value>)',
          800: 'rgb(var(--amber-800) / <alpha-value>)',
          900: 'rgb(var(--amber-900) / <alpha-value>)',
        },
        emerald: {
          50:  'rgb(var(--emerald-50) / <alpha-value>)',
          100: 'rgb(var(--emerald-100) / <alpha-value>)',
          200: 'rgb(var(--emerald-200) / <alpha-value>)',
          300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669',
          700: 'rgb(var(--emerald-700) / <alpha-value>)',
          800: 'rgb(var(--emerald-800) / <alpha-value>)',
          900: 'rgb(var(--emerald-900) / <alpha-value>)',
        },
        /* The middle of the band scale. Same treatment, or lime and green
           keep pale chips on a dark page while red, amber and emerald
           either side of them flip. */
        green: {
          50:  'rgb(var(--green-50) / <alpha-value>)',
          100: 'rgb(var(--green-100) / <alpha-value>)',
          200: 'rgb(var(--green-200) / <alpha-value>)',
          300: '#86efac', 400: '#4ade80', 500: '#22c55e', 600: '#16a34a',
          700: 'rgb(var(--green-700) / <alpha-value>)',
          800: 'rgb(var(--green-800) / <alpha-value>)',
          900: 'rgb(var(--green-900) / <alpha-value>)',
        },
        lime: {
          50:  'rgb(var(--lime-50) / <alpha-value>)',
          100: 'rgb(var(--lime-100) / <alpha-value>)',
          200: 'rgb(var(--lime-200) / <alpha-value>)',
          300: '#bef264', 400: '#a3e635', 500: '#84cc16', 600: '#65a30d',
          700: 'rgb(var(--lime-700) / <alpha-value>)',
          800: 'rgb(var(--lime-800) / <alpha-value>)',
          900: 'rgb(var(--lime-900) / <alpha-value>)',
        },
        violet: {
          50:  'rgb(var(--violet-50) / <alpha-value>)',
          100: 'rgb(var(--violet-100) / <alpha-value>)',
          200: 'rgb(var(--violet-200) / <alpha-value>)',
          300: '#c4b5fd', 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed',
          700: 'rgb(var(--violet-700) / <alpha-value>)',
          800: 'rgb(var(--violet-800) / <alpha-value>)',
          900: 'rgb(var(--violet-900) / <alpha-value>)',
        },
        cyrixRed: {
          50:  'rgb(var(--red-50) / <alpha-value>)',
          100: 'rgb(var(--red-100) / <alpha-value>)',
          200: 'rgb(var(--red-200) / <alpha-value>)',
          300: '#f7a8af', 400: '#f17886', 500: '#e64a5f', 600: '#e30613',
          700: 'rgb(var(--red-700) / <alpha-value>)',
          800: 'rgb(var(--red-800) / <alpha-value>)',
          900: 'rgb(var(--red-900) / <alpha-value>)',
          950: '#460610',
        },
      },
      fontFamily: {
        /*
         * SF Pro, the same stack every Cyrix module uses.
         *
         * It is Apple's font and licensed only for Apple platforms, so it
         * cannot be shipped. -apple-system picks it up where it already
         * exists; Inter is bundled as the stand-in everywhere else, close
         * enough in metrics that the layout does not shift between a
         * phone and a desk.
         */
        sans: [
          'SF Pro Text',
          '-apple-system',
          'BlinkMacSystemFont',
          'Inter Variable',
          'Inter',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      letterSpacing: {
        label: '0.16em',
      },
    },
  },
  plugins: [],
}
