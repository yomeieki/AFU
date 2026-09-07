/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // 实测（9 项中文标签 + Logo + 右侧按钮 + 内边距的最小视口）：
      //   纯文字一行 878px  → navrow 取 960，低于它改走九宫格面板
      //   带图标一行 1134px → nav 取 1200，低于它去掉图标与「退出登录」文字
      screens: {
        navrow: '960px',
        nav: '1200px',
      },
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
      keyframes: {
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(-8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'toast-in': 'toast-in .2s ease-out',
      },
    },
  },
  plugins: [],
}
