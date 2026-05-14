/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      fontFamily: {
        mono: ["SF Mono", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
