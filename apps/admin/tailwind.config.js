/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // 品牌色阶，规范见 docs/design-system.md
      colors: {
        brand: {
          50: '#fef4f0',
          100: '#fde5dc',
          200: '#fac9b8',
          300: '#f6a288',
          400: '#ef7150',
          500: '#e5441e',
          600: '#c33514',
          700: '#a02b13',
          800: '#802514',
          900: '#6a2214',
        },
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04)',
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #ff6a3d 0%, #e5441e 100%)',
      },
    },
  },
  plugins: [],
}
