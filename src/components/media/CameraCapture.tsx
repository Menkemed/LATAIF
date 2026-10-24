// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT D10 / Artikelfotos — ein Foto direkt mit der Kamera des Rechners aufnehmen.
//
// Bisher gab es am Desktop nur „Datei wählen" (Galerie); die Kamera hatte nur das Telefon. Diese Maske
// öffnet die Kamera (getUserMedia), zeigt das Bild, nimmt auf Klick EIN Foto auf und gibt es durch
// DENSELBEN Normalisierer wie jede Datei (`captureImage`: JPEG, ≤ 100 000 B, EXIF-Drehung). Nichts wird
// hier gespeichert; die Kamera wird beim Schließen sofort wieder freigegeben.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { captureImage } from '@/core/media/capture-profile';

/** Kann dieser Rechner überhaupt eine Kamera anbieten? (Ohne API kein Knopf.) */
export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
}

export interface CameraCaptureProps {
  open: boolean;
  onClose: () => void;
  /** Das aufgenommene, normalisierte Foto als Daten-URL. */
  onCapture: (dataUrl: string) => void;
  title?: string;
}

export function CameraCapture({ open, onClose, onCapture, title = 'Take photo' }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError('');
    setReady(false);
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => undefined);
        }
        setReady(true);
      } catch (e) {
        if (!cancelled) setError(`The camera could not be opened (${e instanceof Error ? e.message : String(e)}). Choose a photo file instead.`);
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setReady(false);
    };
  }, [open]);

  async function take(): Promise<void> {
    const v = videoRef.current;
    if (!v || !v.videoWidth || busy) return;
    setBusy(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) throw new Error('no image');
      const dataUrl = await captureImage(new File([blob], 'camera.jpg', { type: 'image/jpeg' }));
      onCapture(dataUrl);
      onClose();
    } catch (e) {
      setError(`The photo could not be taken (${e instanceof Error ? e.message : String(e)}).`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-camera-capture>
        <video ref={videoRef} playsInline muted
          style={{ width: '100%', maxHeight: 360, background: '#0F0F10', borderRadius: 6, objectFit: 'contain' }} />
        {error && <div style={{ fontSize: 12, color: '#B91C1C' }}>{error}</div>}
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void take()} disabled={!ready || busy} data-camera-take>
            <Camera size={14} /> {busy ? 'Taking…' : 'Take photo'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
