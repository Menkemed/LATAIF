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
    bg: '#715DE3', border: '1px solid #715DE3', color: '#FFFFFF',
    hoverBg: '#5B3DCC', hoverBorder: '1px solid #5B3DCC', hoverColor: '#FFFFFF',
  },
  secondary: {
    bg: '#FFFFFF', border: '1px solid #E5E9EE', color: '#0F0F10',
    hoverBg: '#F2F7FA', hoverBorder: '1px solid #715DE3', hoverColor: '#715DE3',
  },
  ghost: {
    bg: 'transparent', border: '1px solid transparent', color: '#6B7280',
    hoverBg: 'rgba(113,93,227,0.06)', hoverBorder: '1px solid transparent', hoverColor: '#715DE3',
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
