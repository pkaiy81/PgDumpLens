/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "media",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  safelist: [
    // Risk badge colors - ensure these are always generated
    "text-green-900",
    "bg-green-200",
    "dark:text-green-100",
    "dark:bg-green-800",
    "border-green-500",
    "text-yellow-900",
    "bg-yellow-200",
    "dark:text-yellow-100",
    "dark:bg-yellow-700",
    "border-yellow-500",
    "text-orange-900",
    "bg-orange-200",
    "dark:text-orange-100",
    "dark:bg-orange-800",
    "border-orange-500",
    "text-red-900",
    "bg-red-200",
    "dark:text-red-100",
    "dark:bg-red-800",
    "border-red-500",
    "text-slate-900",
    "bg-slate-200",
    "dark:text-slate-100",
    "dark:bg-slate-700",
    "border-slate-500",
  ],
  theme: {
    extend: {
      colors: {
        risk: {
          low: "#22c55e",
          medium: "#eab308",
          high: "#f97316",
          critical: "#ef4444",
        },
      },
    },
  },
  plugins: [],
};
