import React from 'react';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (val: number) => void;
  accentColor?: string; // Tailwind class for accent color, e.g., "accent-indigo-500"
}

const Slider: React.FC<SliderProps> = ({ 
  label, value, min, max, step = 1, unit = '', onChange, accentColor = "accent-indigo-500" 
}) => {
  return (
    <div className="mb-4">
      <div className="flex justify-between items-center mb-1">
        <label className="text-sm font-medium text-slate-300">{label}</label>
        <span className="text-xs font-mono text-slate-400">{value}{unit}</span>
      </div>
      <div className="relative w-full h-6 flex items-center">
        <input 
          type="range" 
          min={min} 
          max={max} 
          step={step}
          value={value} 
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className={`w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer ${accentColor} focus:outline-none focus:ring-2 focus:ring-opacity-50`}
        />
      </div>
      <div className="flex justify-between text-[10px] text-slate-500 font-mono">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
};

export default Slider;