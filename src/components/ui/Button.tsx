import { type ButtonHTMLAttributes, type ReactNode, useState } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
  icon?: ReactNode;
  fullWidth?: boolean;
}

const baseStyles: Record<ButtonVariant, { bg: string; border: string; color: string; hoverBg: string; hoverBorder: string; hoverColor: string }> = {
  primary: {
    bg: '#0F0F10', border: '1px solid #0F0F10', color: '#FFFFFF',
    hoverBg: '#1F1F22', hoverBorder: '1px solid #1F1F22', hoverColor: '#FFFFFF',
  },
  secondary: {
    bg: '#FFFFFF', border: '1px solid #D5D1C4', color: '#0F0F10',
    hoverBg: '#F6F3EA', hoverBorder: '1px solid #0F0F10', hoverColor: '#0F0F10',
  },
  ghost: {
    bg: 'transparent', border: '1px solid transparent', color: '#4B5563',
    hoverBg: 'rgba(15,15,16,0.05)', hoverBorder: '1px solid transparent', hoverColor: '#0F0F10',
  },
  danger: {
    bg: '#FFFFFF', border: '1px solid #DC2626', color: '#DC2626',
    hoverBg: 'rgba(220,38,38,0.08)', hoverBorder: '1px solid #DC2626', hoverColor: '#B91C1C',
  },
};

export function Button({
  variant = 'secondary', children, icon, fullWidth = false, className = '', style, ...props
}: ButtonProps) {
  const [hovered, setHovered] = useState(false);
  const s = baseStyles[variant];

  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-full transition-all duration-200 select-none ${className}`}
      style={{
        padding: '10px 22px',
        fontSize: 13,
        fontWeight: 500,
        letterSpacing: '0.01em',
        minWidth: 110,
        width: fullWidth ? '100%' : undefined,
        background: hovered ? s.hoverBg : s.bg,
        border: hovered ? s.hoverBorder : s.border,
        color: hovered ? s.hoverColor : s.color,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        opacity: props.disabled ? 0.4 : 1,
        ...style,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      {...props}
    >
      {icon && <span style={{ width: 16, height: 16 }}>{icon}</span>}
      {children}
    </button>
  );
}
