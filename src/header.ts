export type Header = {
  height: number
  draw(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tx: number, tw: number): void
  onMouseDown?(event: MouseEvent, x: number, y: number, w: number, h: number, tx: number, tw: number): void
} | null
