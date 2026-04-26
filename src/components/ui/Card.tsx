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
      className={`rounded-lg transition-all duration-300 ${className}`}
      style={{
        background: '#FFFFFF',
        border: `1px solid ${hovered && hoverable ? '#D5D1C4' : '#E5E1D6'}`,
        padding: noPadding ? 0 : 24,
        cursor: hoverable ? 'pointer' : undefined,
        transform: hovered && hoverable ? 'translateY(-1px)' : 'translateY(0)',
        boxShadow: hovered && hoverable ? '0 0 20px rgba(198,163,109,0.04)' : 'none',
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
