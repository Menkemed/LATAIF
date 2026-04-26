import { type ReactNode, useState } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  hoverable?: boolean;
  onClick?: () => void;
  noPadding?: boolean;
}

export function Card({ children, className = '', hoverable = false, onClick, noPadding = false }: CardProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className={`transition-all duration-200 ${className}`}
      style={{
        background: '#FFFFFF',
        border: '1px solid #E5E9EE',
        borderRadius: 16,
        padding: noPadding ? 0 : 22,
        cursor: hoverable ? 'pointer' : undefined,
        transform: hovered && hoverable ? 'translateY(-2px)' : 'translateY(0)',
        boxShadow: hovered && hoverable ? '0 8px 24px rgba(15,15,16,0.06)' : 'none',
        overflow: 'hidden',
      }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </div>
  );
}
