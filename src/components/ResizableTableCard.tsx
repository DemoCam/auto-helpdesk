import React, { useRef, useState, useCallback } from 'react';

interface Props {
  id?: string;
  className?: string;
  children: React.ReactNode;
}

const ResizableTableCard: React.FC<Props> = ({ id, className = '', children }) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = cardRef.current?.offsetWidth ?? 0;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      const parent = cardRef.current?.parentElement?.offsetWidth ?? 1;
      const newW = Math.min(parent, Math.max(260, startW.current + delta));
      setWidth(newW);
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  return (
    <div
      ref={cardRef}
      id={id}
      className={`table-card ${className}`}
      style={width !== null ? { width } : undefined}
    >
      {children}
      <div className="card-resize-handle" onMouseDown={onMouseDown} title="Arrastra para ajustar el ancho">
        <div className="card-resize-handle-dots">
          <span /><span /><span /><span /><span />
        </div>
      </div>
    </div>
  );
};

export default ResizableTableCard;
