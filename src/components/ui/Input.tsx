import { type InputHTMLAttributes, forwardRef, useState } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, required, className = '', ...props }, ref) => {
    const [focused, setFocused] = useState(false);
    // Strip auto `*` if user already added one to label.
    const displayLabel = label && required && !label.trim().endsWith('*') ? label : label;

    return (
      <div className={className}>
        {displayLabel && (
          <label className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
            {displayLabel}
            {required && <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>}
          </label>
        )}
        <input
          ref={ref}
          className="w-full outline-none transition-colors duration-300"
          style={{
            background: 'transparent',
            borderBottom: `1px solid ${error ? '#DC2626' : focused ? '#0F0F10' : '#D5D9DE'}`,
            padding: '10px 0',
            fontSize: 14,
            color: '#0F0F10',
          }}
          placeholder={props.placeholder}
          required={required}
          onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
          onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
          {...props}
        />
        {error && (
          <span style={{ fontSize: 12, color: '#DC2626', marginTop: 4, display: 'block' }}>{error}</span>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
