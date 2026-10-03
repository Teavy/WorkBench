import React, { useState, useRef, useEffect, useCallback } from 'react';
import { CameraState } from '../types';
import { Image as ImageIcon, RotateCcw, Box } from 'lucide-react';

interface CameraOrbitProps {
  camera: CameraState;
  onChange: (newCamera: CameraState) => void;
  label: string;
  resetCamera: CameraState;
  relative?: boolean;
}

const CameraOrbit: React.FC<CameraOrbitProps> = ({ camera, onChange, label, resetCamera, relative = false }) => {
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, az: 0, el: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // --- Interaction Handlers ---
  
  const handleMouseDown = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault(); // Prevent scrolling on touch
    setIsDragging(true);
    
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;

    dragStartRef.current = {
      x: clientX,
      y: clientY,
      az: camera.azimuth,
      el: camera.elevation
    };
  };

  const handleMouseMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDragging) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
    
    const deltaX = clientX - dragStartRef.current.x;
    const deltaY = clientY - dragStartRef.current.y;

    // Sensitivity
    const sensitivityX = 0.5; 
    const sensitivityY = 0.5; 

    // Drag right increases azimuth and reveals the character's own R side.
    let newAz = dragStartRef.current.az + (deltaX * sensitivityX);
    
    // Elevation: Drag Down (DeltaY > 0) -> Increase Elevation (Show Top).
    let newEl = dragStartRef.current.el + (deltaY * sensitivityY);

    // Clamping
    newEl = Math.max(-90, Math.min(90, newEl));
    
    // Wrapping Azimuth
    while (newAz > 180) newAz -= 360;
    while (newAz <= -180) newAz += 360;

    onChange({
      ...camera,
      azimuth: Math.round(newAz),
      elevation: Math.round(newEl)
    });

  }, [isDragging, camera, onChange]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('touchmove', handleMouseMove, { passive: false });
      window.addEventListener('touchend', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchmove', handleMouseMove);
      window.removeEventListener('touchend', handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const handleReset = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange({ ...camera, azimuth: resetCamera.azimuth, elevation: resetCamera.elevation });
  };

  // --- 3D Cube Transform ---
  // Match the prompt convention: negative = character L, positive = character R.
  const cubeTransform = {
    transform: `rotateX(${-camera.elevation}deg) rotateY(${camera.azimuth}deg)`
  };

  const faceClasses = "absolute inset-0 bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400 font-mono text-xl font-bold select-none shadow-inner backface-hidden";
  
  const size = "w-24 h-24";
  
  // 47px for stronger overlap to fix gaps
  const translateZ = "translateZ(47px)"; 

  return (
    <div 
      className="relative w-full h-full min-h-[260px] bg-black rounded-xl overflow-hidden cursor-grab active:cursor-grabbing border border-slate-800 shadow-inner group"
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onTouchStart={handleMouseDown}
    >
      {/* Grid Background */}
      <div className="absolute inset-0 opacity-20 pointer-events-none" 
           style={{ 
             backgroundImage: 'linear-gradient(#334155 1px, transparent 1px), linear-gradient(90deg, #334155 1px, transparent 1px)',
             backgroundSize: '40px 40px'
           }}>
      </div>
      
      {/* Center Crosshair */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
         <div className="w-4 h-0.5 bg-slate-400"></div>
         <div className="h-4 w-0.5 bg-slate-400 absolute"></div>
      </div>

      {/* Label */}
      <div className="absolute top-4 left-4 text-xs font-bold text-slate-500 uppercase tracking-wider pointer-events-none z-10">
        {label} · drag to adjust
      </div>

      {/* Reset Button */}
      { (camera.azimuth !== resetCamera.azimuth || camera.elevation !== resetCamera.elevation) && (
        <button 
          onClick={handleReset}
          className="absolute bottom-4 left-4 z-20 flex items-center gap-1.5 px-3 py-1.5 bg-slate-900/80 hover:bg-slate-800 border border-slate-700 rounded text-xs text-slate-400 hover:text-white transition-all shadow-lg backdrop-blur-md"
        >
          <RotateCcw className="w-3 h-3" /> Reset
        </button>
      )}

      {/* 3D Scene Container */}
      <div className="absolute inset-0 flex items-center justify-center perspective-1000 pointer-events-none">
        {/* The Cube */}
        <div 
          className={`relative ${size} transform-style-3d transition-transform duration-75 ease-out`}
          style={cubeTransform}
        >
          {/* Front Face */}
          <div className={`${faceClasses} overflow-hidden`} style={{ transform: `${translateZ}` }}>
             <div className="flex flex-col items-center gap-1 text-sm"><ImageIcon className="w-5 h-5 text-indigo-400" />{relative ? 'INPUT' : 'FRONT'}</div>
          </div>
          
          {/* Back Face */}
          <div className={`${faceClasses}`} style={{ transform: `rotateY(180deg) ${translateZ}` }}>
             <div className="w-2 h-2 rounded-full bg-slate-600"></div>
          </div>
          
          {/* Character's anatomical left side */}
          <div className={`${faceClasses}`} style={{ transform: `rotateY(90deg) ${translateZ}` }}>
             <span className="text-emerald-500">{relative ? '−' : 'L'}</span>
          </div>
          
          {/* Character's anatomical right side */}
          <div className={`${faceClasses}`} style={{ transform: `rotateY(-90deg) ${translateZ}` }}>
             <span className="text-emerald-500">{relative ? '+' : 'R'}</span>
          </div>
          
          {/* Top Face */}
          <div className={`${faceClasses}`} style={{ transform: `rotateX(90deg) ${translateZ}` }}>
             <span className="text-pink-500 text-sm">TOP</span>
          </div>
          
          {/* Bottom Face */}
          <div className={`${faceClasses}`} style={{ transform: `rotateX(-90deg) ${translateZ}` }}>
             <span className="text-pink-500 text-sm">BTM</span>
          </div>
        </div>
      </div>

      {/* Visual Axis Indicator */}
      <div className="absolute bottom-4 right-4 pointer-events-none opacity-50">
        <Box className="w-5 h-5 text-slate-600" />
      </div>

    </div>
  );
};

export default CameraOrbit;
