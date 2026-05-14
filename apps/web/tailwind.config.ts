import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class', 'html[data-theme="dark"]'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: 'var(--bg-primary)',
          secondary: 'var(--bg-secondary)',
          tertiary: 'var(--bg-tertiary)',
        },
        txt: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
        },
        brand: {
          purple: 'rgb(var(--brand-purple-rgb) / <alpha-value>)',
          'purple-deep': 'rgb(var(--brand-purple-deep-rgb) / <alpha-value>)',
          orange: 'rgb(var(--brand-orange-rgb) / <alpha-value>)',
          yellow: 'rgb(var(--brand-yellow-rgb) / <alpha-value>)',
        },
        status: {
          success: 'rgb(var(--status-success-rgb) / <alpha-value>)',
          warning: 'rgb(var(--status-warning-rgb) / <alpha-value>)',
          error: 'rgb(var(--status-error-rgb) / <alpha-value>)',
          // `danger` is the Korean-market-aligned synonym used across the
          // codebase for down-tick / risk / 위험 indicators. Aliased to the
          // same RGB as error so a 30-file rename isn't required.
          danger: 'rgb(var(--status-error-rgb) / <alpha-value>)',
          info: 'rgb(var(--status-info-rgb) / <alpha-value>)',
        },
        border: {
          subtle: 'var(--border-subtle)',
          DEFAULT: 'var(--border-default)',
          hover: 'var(--border-hover)',
          'hover-strong': 'var(--border-hover-strong)',
          'hover-max': 'var(--border-hover-max)',
          focus: 'var(--border-focus)',
          divider: 'var(--border-divider)',
          'divider-faint': 'var(--border-divider-faint)',
        },
        surface: {
          overlay: 'var(--surface-overlay)',
        },

        // ── shadcn/ui aliases → MeetFlow tokens ──
        background: 'var(--bg-primary)',
        foreground: 'var(--text-primary)',
        card: {
          DEFAULT: 'var(--bg-secondary)',
          foreground: 'var(--text-primary)',
        },
        popover: {
          DEFAULT: 'var(--bg-secondary)',
          foreground: 'var(--text-primary)',
        },
        primary: {
          DEFAULT: 'rgb(var(--brand-purple-rgb) / <alpha-value>)',
          foreground: '#FFFFFF',
        },
        secondary: {
          DEFAULT: 'var(--bg-tertiary)',
          foreground: 'var(--text-primary)',
        },
        muted: {
          DEFAULT: 'var(--bg-tertiary)',
          foreground: 'var(--text-secondary)',
        },
        accent: {
          DEFAULT: 'var(--bg-tertiary)',
          foreground: 'var(--text-primary)',
        },
        destructive: {
          DEFAULT: 'rgb(var(--status-error-rgb) / <alpha-value>)',
          foreground: '#FFFFFF',
        },
        input: 'var(--border-default)',
        ring: 'var(--border-focus)',
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
      },
      fontFamily: {
        heading: ['var(--font-heading)', 'Gilroy', 'Inter', 'sans-serif'],
        sub: ['var(--font-sub)', 'Lufga', 'Inter', 'sans-serif'],
        body: ['var(--font-body)', 'Inter', 'Pretendard', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        glow: 'var(--shadow-glow)',
      },
      backgroundImage: {
        'gradient-brand': 'var(--gradient-brand)',
        'gradient-warm': 'var(--gradient-warm)',
        'gradient-card': 'var(--gradient-card)',
      },
      transitionDuration: {
        fast: '150ms',
        base: '200ms',
        slow: '300ms',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
