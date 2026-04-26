import { type InputHTMLAttributes, forwardRef, useState } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = '', ...props }, ref) => {
    const [focused, setFocused] = useState(false);

    return (
      <div className={className}>
        {label && (
          <label className="text-overline" style={{ marginBottom: 6 }}>{label}</label>
        )}
        <input
          ref={ref}
          className="w-full outline-none transition-colors duration-300"
          style={{
            background: 'transparent',
            borderBottom: `1px solid ${error ? '#AA6E6E' : focused ? '#0F0F10' : '#D5D1C4'}`,
            padding: '10px 0',
            fontSize: 14,
            color: '#0F0F10',
          }}
          placeholder={props.placeholder}
          onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
          onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
          {...props}
        />
        {error && (
          <span style={{ fontSize: 12, color: '#AA6E6E', marginTop: 4, display: 'block' }}>{error}</span>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
