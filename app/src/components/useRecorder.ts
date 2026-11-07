import { useEffect, useRef, useState } from 'react';

const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

/**
 * Gravação de áudio no navegador (microfone). `onDone` recebe o arquivo quando a pessoa para
 * (ou quando chega em `maxSeconds`). `cancel` descarta sem entregar.
 */
export function useRecorder({ maxSeconds = 120, onDone }: { maxSeconds?: number; onDone: (blob: Blob, seconds: number) => void }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  const discard = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;
  const supported = typeof window !== 'undefined' && 'MediaRecorder' in window && !!navigator.mediaDevices?.getUserMedia;

  const cleanup = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setRecording(false);
  };

  async function start() {
    if (!supported || recording) return;
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = s;
      const mime = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
      const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      discard.current = false;
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => {
        const secs = (Date.now() - startedAt.current) / 1000;
        const blob = new Blob(chunks.current, { type: r.mimeType || mime || 'audio/webm' });
        cleanup();
        if (!discard.current && blob.size > 0) done.current(blob, secs);
      };
      rec.current = r;
      startedAt.current = Date.now();
      setSeconds(0);
      r.start(250);
      setRecording(true);
      timer.current = setInterval(() => {
        const secs = (Date.now() - startedAt.current) / 1000;
        setSeconds(secs);
        if (secs >= maxSeconds && rec.current?.state === 'recording') rec.current.stop();
      }, 200);
    } catch (e) {
      cleanup();
      const name = (e as DOMException)?.name;
      setError(name === 'NotAllowedError' ? 'Permita o uso do microfone no navegador para gravar.' : 'Não foi possível usar o microfone.');
    }
  }

  function stop() { if (rec.current?.state === 'recording') rec.current.stop(); }
  function cancel() { discard.current = true; if (rec.current?.state === 'recording') rec.current.stop(); else cleanup(); }

  useEffect(() => () => { discard.current = true; if (rec.current?.state === 'recording') rec.current.stop(); cleanup(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { supported, recording, seconds, error, start, stop, cancel };
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
