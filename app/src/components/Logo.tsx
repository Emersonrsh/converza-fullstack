/** Logo da Converza (arquivo em public/logo.png, fundo transparente). */
export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  return <img src="/logo.png" width={size} height={size} alt="Converza" className={className} style={{ display: 'block', objectFit: 'contain' }} draggable={false} />;
}
