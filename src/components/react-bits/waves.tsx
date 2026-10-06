"use client";

/*
 * Basado en "Waves" de React Bits (https://reactbits.dev, David Haz), licencia MIT + Commons
 * Clause: ver ./LICENSE.md. Adaptado para Cotiza Prime: sin dependencias (dibuja en un lienzo 2D),
 * líneas más separadas y 30 cuadros por segundo para gastar poco, se detiene cuando no se ve
 * (otra pestaña o fuera de pantalla), sin seguimiento del ratón y con colores del sistema de diseño.
 */

import { useEffect, useRef } from "react";

const FRAME_MS = 1000 / 30;
const NOISE_SIZE = 256;

/** Ruido suave determinista (ruido de Perlin simplificado en 2D). */
function createNoise(seed: number) {
  const perm = new Uint8Array(NOISE_SIZE * 2);
  const values = Array.from({ length: NOISE_SIZE }, (_, index) => index);
  let state = seed;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  for (let index = NOISE_SIZE - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  for (let index = 0; index < NOISE_SIZE * 2; index++) perm[index] = values[index % NOISE_SIZE];
  const gradients = [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a: number, b: number, t: number) => (1 - t) * a + t * b;
  const dot = (hash: number, x: number, y: number) => {
    const [gx, gy] = gradients[hash % gradients.length];
    return gx * x + gy * y;
  };
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const n00 = dot(perm[X + perm[Y]], xf, yf);
    const n10 = dot(perm[X + 1 + perm[Y]], xf - 1, yf);
    const n01 = dot(perm[X + perm[Y + 1]], xf, yf - 1);
    const n11 = dot(perm[X + 1 + perm[Y + 1]], xf - 1, yf - 1);
    const u = fade(xf);
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), fade(yf));
  };
}

type Point = { x: number; y: number };

/**
 * Líneas onduladas de fondo. Decorativo: `aria-hidden`, sin eventos. Quien lo use decide cuándo
 * montarlo (`AnimatedBackdrop`): no se dibuja con "reducir movimiento" ni en teléfonos modestos.
 */
export default function Waves({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!container || !canvas || !context) return;

    const noise = createNoise(7);
    const lineColor = getComputedStyle(container).color;
    const xGap = 16;
    const yGap = 40;
    const amplitudeX = 32;
    const amplitudeY = 16;
    let lines: Point[][] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let lastDraw = 0;
    let onScreen = true;

    function resize() {
      const rect = container!.getBoundingClientRect();
      width = canvas!.width = Math.max(1, Math.round(rect.width));
      height = canvas!.height = Math.max(1, Math.round(rect.height));
      const columns = Math.ceil((width + 200) / xGap);
      const rows = Math.ceil((height + 30) / yGap);
      const startX = (width - xGap * columns) / 2;
      const startY = (height - yGap * rows) / 2;
      lines = Array.from({ length: columns + 1 }, (_, column) =>
        Array.from({ length: rows + 1 }, (_, row) => ({
          x: startX + xGap * column,
          y: startY + yGap * row,
        })),
      );
    }

    function draw(time: number) {
      context!.clearRect(0, 0, width, height);
      context!.beginPath();
      context!.strokeStyle = lineColor;
      for (const points of lines) {
        points.forEach((point, index) => {
          const angle =
            noise((point.x + time * 0.0125) * 0.002, (point.y + time * 0.005) * 0.0015) * 12;
          const x = point.x + Math.cos(angle) * amplitudeX;
          const y = point.y + Math.sin(angle) * amplitudeY;
          if (index === 0) context!.moveTo(x, y);
          else context!.lineTo(x, y);
        });
      }
      context!.stroke();
    }

    function tick(time: number) {
      frame = requestAnimationFrame(tick);
      if (time - lastDraw < FRAME_MS) return;
      lastDraw = time;
      draw(time);
    }

    function start() {
      if (!frame && onScreen && !document.hidden) frame = requestAnimationFrame(tick);
    }
    function stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    }

    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen) start();
      else stop();
    });
    const resizeObserver = new ResizeObserver(resize);
    const onVisibility = () => (document.hidden ? stop() : start());

    resize();
    observer.observe(container);
    resizeObserver.observe(container);
    document.addEventListener("visibilitychange", onVisibility);
    start();

    return () => {
      stop();
      observer.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ""}`}
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}
