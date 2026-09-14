import React, { useRef, useEffect } from 'react';
import { InfographicData } from '../types';
import { Download, Sparkles, Image as ImageIcon } from 'lucide-react';

interface InfographicCanvasProps {
  data: InfographicData;
  width?: number;
  height?: number;
}

export const InfographicCanvas: React.FC<InfographicCanvasProps> = ({
  data,
  width = 600,
  height = 420
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const drawInfographic = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Canvas dimensions for high-DPI crisp rendering
    const scale = window.devicePixelRatio || 2;
    canvas.width = width * scale;
    canvas.height = height * scale;
    ctx.scale(scale, scale);

    // Color Palette based on theme
    let bgGradientStart = '#0F172A';
    let bgGradientEnd = '#1E1B4B';
    let accentColor = '#6366F1';
    let highlightBg = 'rgba(99, 102, 241, 0.18)';
    let highlightBorder = 'rgba(129, 140, 248, 0.4)';
    let textLeftColor = '#94A3B8';
    let textRightColor = '#38BDF8';

    if (data.theme === 'emerald') {
      bgGradientStart = '#064E3B';
      bgGradientEnd = '#022C22';
      accentColor = '#10B981';
      highlightBg = 'rgba(16, 185, 129, 0.2)';
      highlightBorder = 'rgba(52, 211, 153, 0.5)';
      textRightColor = '#34D399';
    } else if (data.theme === 'contrast') {
      bgGradientStart = '#18181B';
      bgGradientEnd = '#09090B';
      accentColor = '#F43F5E';
      highlightBg = 'rgba(244, 63, 94, 0.2)';
      highlightBorder = 'rgba(251, 113, 133, 0.5)';
      textRightColor = '#FB7185';
    }

    // 1. Background Gradient
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, bgGradientStart);
    gradient.addColorStop(1, bgGradientEnd);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Subtle background mesh grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Outer Glow Border
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 3;
    ctx.strokeRect(1, 1, width - 2, height - 2);

    // Header Title
    ctx.font = 'bold 22px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = '#F8FAFC';
    ctx.textAlign = 'center';
    ctx.fillText(data.title.toUpperCase(), width / 2, 44);

    // Subtitle Badge
    ctx.font = '500 13px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = '#94A3B8';
    ctx.fillText(data.subtitle, width / 2, 70);

    // Header Divider Line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, 85);
    ctx.lineTo(width - 40, 85);
    ctx.stroke();

    // Column Labels (VS Header)
    ctx.font = '700 12px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = '#F43F5E';
    ctx.textAlign = 'left';
    ctx.fillText('❌ WASTE OF TIME / OLD WAY', 50, 112);

    ctx.fillStyle = '#10B981';
    ctx.textAlign = 'right';
    ctx.fillText('✅ WHERE GROWTH HAPPENS', width - 50, 112);

    // Draw Items Rows
    const startY = 135;
    const rowHeight = 52;
    const rowWidth = width - 80;

    data.items.forEach((item, index) => {
      const y = startY + index * rowHeight;

      // Row background card
      ctx.fillStyle = item.highlight ? highlightBg : 'rgba(255, 255, 255, 0.03)';
      ctx.strokeStyle = item.highlight ? highlightBorder : 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;

      // Rounded rectangle
      const radius = 8;
      const x = 40;
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + rowWidth - radius, y);
      ctx.quadraticCurveTo(x + rowWidth, y, x + rowWidth, y + radius);
      ctx.lineTo(x + rowWidth, y + rowHeight - 14 + radius);
      ctx.quadraticCurveTo(x + rowWidth, y + rowHeight - 14, x + rowWidth - radius, y + rowHeight - 14);
      ctx.lineTo(x + radius, y + rowHeight - 14);
      ctx.quadraticCurveTo(x, y + rowHeight - 14, x, y + rowHeight - 14 - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Row Content Left
      ctx.font = '500 13px "Plus Jakarta Sans", sans-serif';
      ctx.fillStyle = textLeftColor;
      ctx.textAlign = 'left';
      ctx.fillText(item.leftText, 56, y + 24);

      // VS indicator in middle
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.textAlign = 'center';
      ctx.fillText('VS', width / 2, y + 24);

      // Row Content Right
      ctx.font = '600 13px "Plus Jakarta Sans", sans-serif';
      ctx.fillStyle = textRightColor;
      ctx.textAlign = 'right';
      ctx.fillText(item.rightText, width - 56, y + 24);
    });

    // Footer Text
    const footerY = height - 24;
    ctx.font = 'italic 12px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.fillText(`⚡ ${data.footerText}`, width / 2, footerY);
  };

  useEffect(() => {
    drawInfographic();
  }, [data, width, height]);

  const handleDownload = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const imageURI = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `infographic_${data.title.toLowerCase().replace(/\s+/g, '_')}.png`;
    link.href = imageURI;
    link.click();
  };

  return (
    <div className="flex flex-col items-center gap-3 w-full my-3">
      <div className="relative rounded-xl overflow-hidden shadow-2xl border border-white/10 group">
        <canvas
          ref={canvasRef}
          style={{ width: `${width}px`, height: `${height}px` }}
          className="max-w-full h-auto block"
        />
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
          <button
            onClick={handleDownload}
            className="btn-emerald text-xs shadow-lg py-2 px-4 flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            Download Infographic PNG
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between w-full text-xs text-slate-400 px-1">
        <span className="flex items-center gap-1">
          <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
          AI-Generated Visual Graphic (600x420)
        </span>
        <button
          onClick={handleDownload}
          className="hover:text-indigo-400 transition-colors flex items-center gap-1 cursor-pointer"
        >
          <ImageIcon className="w-3.5 h-3.5" />
          Export Image
        </button>
      </div>
    </div>
  );
};
