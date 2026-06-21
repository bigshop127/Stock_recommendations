/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: '#09090b',
        card: '#18181b',
        border: '#27272a',
        primary: '#3b82f6',
        bull: '#ef4444',
        bear: '#22c55e',
        neutral: '#f59e0b',
        accent: '#06b6d4',
      },
    },
  },
  plugins: [],
};
