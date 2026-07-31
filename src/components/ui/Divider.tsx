interface DividerProps {
  className?: string;
}

export function Divider({ className = "" }: DividerProps) {
  return <hr className={`w-full h-px bg-divider border-0 my-4 ${className}`} />;
}
