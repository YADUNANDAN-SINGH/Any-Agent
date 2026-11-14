/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        agent: {
          bg: '#191919',
          surface: '#232323',
          card: '#2A2A2A',
          border: '#383838',
          accent: '#D97757',
          accentHover: '#E5886A',
          text: '#F3F2EE',
          muted: '#A19F99'
        }
      }
    },
  },
  plugins: [],
}
