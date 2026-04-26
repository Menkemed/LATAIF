import { useRef, useState } from 'react';
import { Plus, X, Image as ImageIcon } from 'lucide-react';

interface ImageUploadProps {
  images: string[];
  onChange: (images: string[]) => void;
  maxImages?: number;
  disabled?: boolean;
}

function compressImage(file: File, maxWidth = 800, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ratio = Math.min(maxWidth / img.width, maxWidth / img.height, 1);
        canvas.width = img.width * ratio;
        canvas.height = img.height * ratio;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function ImageUpload({ images, onChange, maxImages = 6, disabled = false }: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files || disabled) return;
    const remaining = maxImages - images.length;
    const toProcess = Array.from(files).slice(0, remaining);
    const newImages: string[] = [];
    for (const file of toProcess) {
      if (!file.type.startsWith('image/')) continue;
      const dataUrl = await compressImage(file);
      newImages.push(dataUrl);
    }
    onChange([...images, ...newImages]);
  }

  function removeImage(index: number) {
    onChange(images.filter((_, i) => i !== index));
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {images.map((src, i) => (
          <div key={i} className="relative rounded-lg" style={{ aspectRatio: '1', overflow: 'hidden', border: '1px solid #E5E9EE' }}>
            <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            {!disabled && (
              <button
                onClick={() => removeImage(i)}
                className="absolute cursor-pointer flex items-center justify-center rounded-full transition-opacity"
                style={{ top: 4, right: 4, width: 22, height: 22, background: '#FFFFFF', border: '1px solid #D5D9DE', color: '#DC2626' }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}

        {images.length < maxImages && !disabled && (
          <div
            className="rounded-lg flex flex-col items-center justify-center cursor-pointer transition-all duration-200"
            style={{
              aspectRatio: '1',
              border: `1px dashed ${dragOver ? '#0F0F10' : '#D5D9DE'}`,
              background: dragOver ? 'rgba(198,163,109,0.04)' : 'transparent',
              color: dragOver ? '#0F0F10' : '#6B7280',
            }}
            onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = '#0F0F10')}
            onMouseLeave={e => { if (!dragOver) e.currentTarget.style.borderColor = '#D5D9DE'; }}
          >
            <Plus size={20} />
            <span style={{ fontSize: 10, marginTop: 4 }}>Add Photo</span>
          </div>
        )}
      </div>

      {images.length === 0 && disabled && (
        <div className="flex items-center justify-center rounded-lg" style={{ height: 120, border: '1px solid #E5E9EE', background: '#F2F7FA' }}>
          <ImageIcon size={32} strokeWidth={1} style={{ color: '#6B7280' }} />
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={e => handleFiles(e.target.files)}
      />
    </div>
  );
}
