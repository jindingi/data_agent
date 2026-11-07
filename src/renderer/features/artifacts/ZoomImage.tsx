import { useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../../components/ui/dialog';
export function ZoomImage({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button className="image-zoom" aria-label={`放大图表 ${alt}`}>
          <img className="artifact-image" src={src} alt={alt} />
        </button>
      </DialogPrimitive.Trigger>
      <DialogContent className="image-dialog">
        <DialogTitle>{alt}</DialogTitle>
        <DialogDescription>原始图表；可滚动查看，按 Escape 返回。</DialogDescription>
        <div className="image-original">
          <img src={src} alt={alt} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
