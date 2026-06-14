/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 老王報告語意色（與股市相反：🔴看多/🟢看空）— 僅用於「老王」訊號渲染
        bull: '#e11d48', // 看多（紅）
        bear: '#16a34a', // 看空（綠）
        neutral: '#d97706', // 中性（橘）
      },
    },
  },
  plugins: [],
};
