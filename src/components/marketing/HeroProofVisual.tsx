"use client";

import Image from "next/image";
import { useState } from "react";

export function HeroProofVisual() {
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  return (
    <div
      className="hero-proof-shell relative aspect-[4/3] w-full max-w-[720px] overflow-hidden rounded-[32px] border border-white/70 bg-clear-ballot/35 shadow-[0_24px_80px_rgba(24,32,29,0.08)]"
      style={{
        transform: `perspective(1000px) rotateX(${tilt.y}deg) rotateY(${tilt.x}deg)`,
      }}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width - 0.5;
        const y = (event.clientY - rect.top) / rect.height - 0.5;
        setTilt({ x: x * 5, y: y * -5 });
      }}
      onMouseLeave={() => setTilt({ x: 0, y: 0 })}
    >
      <Image
        src="/votum-proof-ballot-hero.png"
        alt="A 3D Votum proof ballot entering a transparent verification chamber with vote proof cards."
        fill
        priority
        sizes="(min-width: 1024px) 58vw, 100vw"
        className="hero-proof-image object-cover"
      />
      <div className="hero-proof-glow" aria-hidden="true" />
    </div>
  );
}
