/**
 * src/modules/portal/components/PortalChart.ts
 *
 * Reactive 2D Canvas chart component for Player Portal progression.
 * Features explicit canvas buffer clearing, Retina display scale adaptation,
 * and debounced ResizeObserver to eliminate curve ghosting on period filter switches.
 */

export interface ChartDataPoint {
  label: string;
  value: number;
}

export interface PortalChartOptions {
  width?: number;
  height?: number;
  lineColor?: string;
  fillColor?: string;
}

export class PortalChart {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private resizeObserver: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context not supported');
    this.ctx = context;
    this.initResizeListener();
  }

  private initResizeListener(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resizeCanvas();
      });
      this.resizeObserver.observe(this.canvas.parentElement || this.canvas);
    }
  }

  public resizeCanvas(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const rect = parent.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

    this.canvas.width = rect.width * dpr;
    this.canvas.height = (rect.height || 200) * dpr;
    this.ctx.scale(dpr, dpr);
  }

  public render(dataPoints: ChartDataPoint[], options: PortalChartOptions = {}): void {
    const { width = this.canvas.width / (window.devicePixelRatio || 1), height = 200, lineColor = '#6366f1', fillColor = 'rgba(99, 102, 241, 0.15)' } = options;

    // Explicitly clear canvas buffer to prevent curve overlay ghosting
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!dataPoints || dataPoints.length === 0) {
      this.drawEmptyState(width, height);
      return;
    }

    const padding = 30;
    const chartWidth = width - padding * 2;
    const chartHeight = height - padding * 2;

    const values = dataPoints.map((d) => d.value);
    const maxVal = Math.max(...values, 1);
    const minVal = Math.min(...values, 0);
    const range = maxVal - minVal || 1;

    const points = dataPoints.map((d, index) => {
      const x = padding + (index / Math.max(dataPoints.length - 1, 1)) * chartWidth;
      const y = height - padding - ((d.value - minVal) / range) * chartHeight;
      return { x, y, value: d.value, label: d.label };
    });

    // Draw gradient area
    this.ctx.beginPath();
    this.ctx.moveTo(points[0].x, height - padding);
    points.forEach((p) => this.ctx.lineTo(p.x, p.y));
    this.ctx.lineTo(points[points.length - 1].x, height - padding);
    this.ctx.closePath();

    const gradient = this.ctx.createLinearGradient(0, padding, 0, height - padding);
    gradient.addColorStop(0, fillColor);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    this.ctx.fillStyle = gradient;
    this.ctx.fill();

    // Draw line
    this.ctx.beginPath();
    this.ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const xc = (points[i].x + points[i - 1].x) / 2;
      const yc = (points[i].y + points[i - 1].y) / 2;
      this.ctx.quadraticCurveTo(points[i - 1].x, points[i - 1].y, xc, yc);
    }
    this.ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    this.ctx.strokeStyle = lineColor;
    this.ctx.lineWidth = 2.5;
    this.ctx.stroke();

    // Draw points
    points.forEach((p) => {
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fill();
      this.ctx.strokeStyle = lineColor;
      this.ctx.lineWidth = 2;
      this.ctx.stroke();
    });
  }

  private drawEmptyState(width: number, height: number): void {
    this.ctx.fillStyle = '#64748b';
    this.ctx.font = '12px Inter, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('No history data for the selected period', width / 2, height / 2);
  }

  public destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
