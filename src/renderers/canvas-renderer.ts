/**
 * JSON Canvas Renderer
 * 
 * Renders JSON Canvas format to PNG images using SVG intermediate.
 * Based on the JSON Canvas spec: https://jsoncanvas.org/spec/1.0/
 */
import { BaseRenderer } from './base-renderer';
import JSONCanvas from '@trbn/jsoncanvas';
import { applyRoughEffect, type RoughSvgOptions } from './libs/rough-svg';
import { parseInlineMarkdown, hasInlineMarkdown } from '../utils/inline-markdown';
import type { RendererThemeConfig, RenderResult } from '../types/index';

// Color presets - softer Obsidian-style colors
const COLOR_PRESETS: Record<string, { fill: string; stroke: string }> = {
  '1': { fill: 'rgba(255, 145, 145, 0.25)', stroke: '#e76f6f' },   // red (softer)
  '2': { fill: 'rgba(255, 190, 130, 0.25)', stroke: '#d9a05b' },  // orange (softer)
  '3': { fill: 'rgba(240, 230, 140, 0.25)', stroke: '#c9b95f' }, // yellow (softer)
  '4': { fill: 'rgba(130, 200, 140, 0.25)', stroke: '#6faf7a' },  // green (softer)
  '5': { fill: 'rgba(140, 210, 210, 0.25)', stroke: '#6fb5b5' },  // cyan (softer)
  '6': { fill: 'rgba(190, 160, 240, 0.25)', stroke: '#9f8fcc' }, // purple (softer)
};

// Default colors
const DEFAULT_NODE_FILL = 'rgba(255, 255, 255, 0.9)';
const DEFAULT_NODE_STROKE = '#666666';
const DEFAULT_EDGE_STROKE = '#aaaaaa';
const DEFAULT_GROUP_FILL = 'rgba(200, 200, 200, 0.2)';
const DEFAULT_GROUP_STROKE = '#aaaaaa';

// Canvas settings
const PADDING = 40;
const NODE_BORDER_RADIUS = 8;
const ARROW_WIDTH = 7;
const ARROW_HEIGHT = 6;
const FONT_SIZE = 14;
const LABEL_FONT_SIZE = 12;
const LINE_HEIGHT = 1.4;
const MIN_DISTANCE_FOR_CURVE = 30;

interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

export class JsonCanvasRenderer extends BaseRenderer {
  private roughOptions: RoughSvgOptions = {
    roughness: 0.5,
    bowing: 0.5,
  };

  private cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const mt = 1 - t;
    return (mt * mt * mt) * p0
      + 3 * (mt * mt) * t * p1
      + 3 * mt * (t * t) * p2
      + (t * t * t) * p3;
  }

  private cubicExtremaTs(p0: number, p1: number, p2: number, p3: number): number[] {
    // Solve derivative: a t^2 + b t + c = 0 for t in (0,1).
    // For cubic bezier, derivative coefficients are:
    // a = -p0 + 3p1 - 3p2 + p3
    // b = 2(p0 - 2p1 + p2)
    // c = p1 - p0
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;

    const eps = 1e-9;
    const out: number[] = [];

    if (Math.abs(a) < eps) {
      if (Math.abs(b) < eps) return out;
      const t = -c / b;
      if (t > 0 && t < 1) out.push(t);
      return out;
    }

    const d = b * b - 4 * a * c;
    if (d < 0) return out;

    const sd = Math.sqrt(d);
    const t1 = (-b + sd) / (2 * a);
    const t2 = (-b - sd) / (2 * a);
    if (t1 > 0 && t1 < 1) out.push(t1);
    if (t2 > 0 && t2 < 1) out.push(t2);
    return out;
  }

  private cubicBezierBounds(
    p0: { x: number; y: number },
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number }
  ): { minX: number; minY: number; maxX: number; maxY: number } {
    const ts = new Set<number>([0, 1]);
    for (const t of this.cubicExtremaTs(p0.x, p1.x, p2.x, p3.x)) ts.add(t);
    for (const t of this.cubicExtremaTs(p0.y, p1.y, p2.y, p3.y)) ts.add(t);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const t of ts) {
      const x = this.cubicAt(p0.x, p1.x, p2.x, p3.x, t);
      const y = this.cubicAt(p0.y, p1.y, p2.y, p3.y, t);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    return { minX, minY, maxX, maxY };
  }

  constructor() {
    super('canvas');
  }

  /**
   * Initialize renderer
   */
  async initialize(themeConfig: RendererThemeConfig | null = null): Promise<void> {
    this._initialized = true;
  }

  /**
   * Calculate canvas bounds from nodes
   */
  private calculateBounds(
    nodes: Array<{ x: number; y: number; width: number; height: number }>,
    edges?: any[],
    nodeMap?: Map<string, any>
  ): CanvasBounds {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const extend = (x: number, y: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };

    for (const node of nodes) {
      extend(node.x, node.y);
      extend(node.x + node.width, node.y + node.height);
    }

    // Include edges in the bounds. Curved edges can extend outside the node bounding box
    // due to bezier control points (e.g. right->right long edges), which would otherwise be clipped.
    if (edges?.length && nodeMap) {
      for (const edge of edges) {
        const fromNode = nodeMap.get(edge.fromNode);
        const toNode = nodeMap.get(edge.toNode);
        if (!fromNode || !toNode) continue;

        const start = this.getConnectionPoint(fromNode, edge.fromSide, 0, 0);
        const end = this.getConnectionPoint(toNode, edge.toSide, 0, 0);
        extend(start.x, start.y);
        extend(end.x, end.y);

        const dx = Math.abs(end.x - start.x);
        const dy = Math.abs(end.y - start.y);
        const straightDist = Math.sqrt(dx * dx + dy * dy);

        if (straightDist >= MIN_DISTANCE_FOR_CURVE) {
          const fromDir = this.getSideDirection(edge.fromSide);
          const toDir = this.getSideDirection(edge.toSide);

          const fromControlDist = this.getControlDistanceForDirection(fromDir, dx, dy);
          const toControlDist = this.getControlDistanceForDirection(toDir, dx, dy);

          const cp1 = { x: start.x + fromDir.x * fromControlDist, y: start.y + fromDir.y * fromControlDist };
          const cp2 = { x: end.x + toDir.x * toControlDist, y: end.y + toDir.y * toControlDist };

          // Using control points directly tends to overshoot the real curve bounds.
          // Compute a tighter bounding box from the bezier extrema to reduce empty margins.
          const bb = this.cubicBezierBounds(start, cp1, cp2, end);
          extend(bb.minX, bb.minY);
          extend(bb.maxX, bb.maxY);
        }

        if (edge.label) {
          const midX = (start.x + end.x) / 2;
          const midY = (start.y + end.y) / 2 - 8;
          extend(midX, midY);
        }
      }
    }

    // Handle empty canvas
    if (nodes.length === 0) {
      minX = minY = 0;
      maxX = maxY = 100;
    }

    const width = maxX - minX + PADDING * 2;
    const height = maxY - minY + PADDING * 2;

    return {
      minX,
      minY,
      maxX,
      maxY,
      width,
      height,
      offsetX: -minX + PADDING,
      offsetY: -minY + PADDING,
    };
  }

  /**
   * Get color from preset or hex value
   */
  private getNodeColors(color?: string): { fill: string; stroke: string } {
    if (!color) {
      return { fill: DEFAULT_NODE_FILL, stroke: DEFAULT_NODE_STROKE };
    }
    if (COLOR_PRESETS[color]) {
      return COLOR_PRESETS[color];
    }
    // Assume it's a hex color
    return {
      fill: color + '33', // Add alpha
      stroke: color,
    };
  }

  /**
   * Get edge color
   */
  private getEdgeColor(color?: string): string {
    if (!color) return DEFAULT_EDGE_STROKE;
    if (COLOR_PRESETS[color]) return COLOR_PRESETS[color].stroke;
    return color;
  }

  /**
   * Escape text for SVG
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Wrap text into lines that fit within a given width
   */
  private wrapText(text: string, maxWidth: number, fontSize: number): string[] {
    const charWidth = fontSize * 0.6; // Approximate character width
    const maxChars = Math.floor(maxWidth / charWidth);
    const lines: string[] = [];
    
    // Split by newlines first
    const paragraphs = text.split('\n');
    
    for (const paragraph of paragraphs) {
      if (paragraph.length <= maxChars) {
        lines.push(paragraph);
      } else {
        // Word wrap
        const words = paragraph.split(' ');
        let currentLine = '';
        
        for (const word of words) {
          if ((currentLine + ' ' + word).trim().length <= maxChars) {
            currentLine = (currentLine + ' ' + word).trim();
          } else {
            if (currentLine) lines.push(currentLine);
            currentLine = word;
          }
        }
        if (currentLine) lines.push(currentLine);
      }
    }
    
    return lines;
  }

  /**
   * Generate SVG for a text node
   */
  private renderTextNode(node: any, offsetX: number, offsetY: number, fontFamily: string): string {
    const x = node.x + offsetX;
    const y = node.y + offsetY;
    const { fill, stroke } = this.getNodeColors(node.color);
    
    // Render rectangle
    let svg = `<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="${NODE_BORDER_RADIUS}" ry="${NODE_BORDER_RADIUS}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
    
    // Render text content using foreignObject for proper text wrapping (supports CJK and markdown)
    if (node.text) {
      const padding = 10;
      const textWidth = node.width - padding * 2;
      const textHeight = node.height - padding * 2;
      
      // Parse inline markdown if present, otherwise use escaped plain text
      const htmlContent = hasInlineMarkdown(node.text)
        ? parseInlineMarkdown(node.text)
        : this.escapeXml(node.text).replace(/\n/g, '<br/>');
      
      // Use foreignObject to embed HTML for proper text wrapping
      svg += `<foreignObject x="${x + padding}" y="${y + padding}" width="${textWidth}" height="${textHeight}">`;
      svg += `<div xmlns="http://www.w3.org/1999/xhtml" style="font-family: ${fontFamily}; font-size: ${FONT_SIZE}px; color: #333333; line-height: ${LINE_HEIGHT}; overflow: hidden; word-wrap: break-word; white-space: pre-wrap;">${htmlContent}</div>`;
      svg += `</foreignObject>`;
    }
    
    return svg;
  }

  /**
   * Generate SVG for a file node
   */
  private renderFileNode(node: any, offsetX: number, offsetY: number, fontFamily: string): string {
    const x = node.x + offsetX;
    const y = node.y + offsetY;
    const { fill, stroke } = this.getNodeColors(node.color);
    
    // Render rectangle
    let svg = `<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="${NODE_BORDER_RADIUS}" ry="${NODE_BORDER_RADIUS}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
    
    // File icon (simple document icon)
    const iconX = x + 10;
    const iconY = y + node.height / 2 - 10;
    svg += `<path d="M${iconX} ${iconY}h12v16h-16v-12l4-4z" fill="none" stroke="#666" stroke-width="1.5"/>`;
    
    // File name
    const fileName = node.file || 'file';
    const textX = x + 35;
    const textY = y + node.height / 2 + 5;
    svg += `<text x="${textX}" y="${textY}" font-family="${fontFamily}" font-size="${FONT_SIZE}" fill="#333333">${this.escapeXml(fileName)}</text>`;
    
    return svg;
  }

  /**
   * Generate SVG for a link node
   */
  private renderLinkNode(node: any, offsetX: number, offsetY: number, fontFamily: string): string {
    const x = node.x + offsetX;
    const y = node.y + offsetY;
    const { fill, stroke } = this.getNodeColors(node.color);
    
    // Render rectangle
    let svg = `<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="${NODE_BORDER_RADIUS}" ry="${NODE_BORDER_RADIUS}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
    
    // Link icon
    const iconX = x + 15;
    const iconY = y + node.height / 2;
    svg += `<circle cx="${iconX}" cy="${iconY}" r="8" fill="none" stroke="#0066cc" stroke-width="1.5"/>`;
    svg += `<path d="M${iconX - 3} ${iconY}h6m-3 -3v6" stroke="#0066cc" stroke-width="1.5"/>`;
    
    // URL text
    const url = node.url || 'link';
    const textX = x + 35;
    const textY = y + node.height / 2 + 5;
    const displayUrl = url.length > 40 ? url.substring(0, 37) + '...' : url;
    svg += `<text x="${textX}" y="${textY}" font-family="${fontFamily}" font-size="${FONT_SIZE}" fill="#0066cc">${this.escapeXml(displayUrl)}</text>`;
    
    return svg;
  }

  /**
   * Generate SVG for a group node
   */
  private renderGroupNode(node: any, offsetX: number, offsetY: number, fontFamily: string): string {
    const x = node.x + offsetX;
    const y = node.y + offsetY;
    
    let fill = DEFAULT_GROUP_FILL;
    let stroke = DEFAULT_GROUP_STROKE;
    
    if (node.color) {
      const colors = this.getNodeColors(node.color);
      fill = colors.fill;
      stroke = colors.stroke;
    }
    
    // Render rectangle with dashed border
    let svg = `<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="${NODE_BORDER_RADIUS}" ry="${NODE_BORDER_RADIUS}" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-dasharray="8,4"/>`;
    
    // Group label
    if (node.label) {
      const textX = x + 10;
      const textY = y - 8;
      svg += `<text x="${textX}" y="${textY}" font-family="${fontFamily}" font-size="${LABEL_FONT_SIZE}" font-weight="bold" fill="#666666">${this.escapeXml(node.label)}</text>`;
    }
    
    return svg;
  }

  /**
   * Get connection point on a node for a given side
   */
  private getConnectionPoint(node: any, side: string | undefined, offsetX: number, offsetY: number): { x: number; y: number } {
    const x = node.x + offsetX;
    const y = node.y + offsetY;
    
    switch (side) {
      case 'top':
        return { x: x + node.width / 2, y: y };
      case 'bottom':
        return { x: x + node.width / 2, y: y + node.height };
      case 'left':
        return { x: x, y: y + node.height / 2 };
      case 'right':
      default:
        return { x: x + node.width, y: y + node.height / 2 };
    }
  }

  /**
   * Generate arrow marker definition for end (toEnd)
   * refX is set to ARROW_WIDTH so the arrow tip aligns with the edge endpoint (node border)
   */
  private getArrowMarker(id: string, color: string): string {
    // refX = ARROW_WIDTH means the arrow tip (rightmost point) is at the line endpoint
    // This prevents the arrow from overlapping into the node
    return `<marker id="${id}" markerWidth="${ARROW_WIDTH}" markerHeight="${ARROW_HEIGHT}" refX="${ARROW_WIDTH}" refY="${ARROW_HEIGHT / 2}" orient="auto">
      <polygon points="0 0, ${ARROW_WIDTH} ${ARROW_HEIGHT / 2}, 0 ${ARROW_HEIGHT}" fill="${color}"/>
    </marker>`;
  }

  /**
   * Generate arrow marker definition for start (fromEnd)
   * The arrow points back toward the start node (reversed shape)
   */
  private getArrowMarkerStart(id: string, color: string): string {
    // For fromEnd arrow, it should point toward the fromNode (reverse direction)
    // Flip the arrow shape: tip at x=0, base at x=ARROW_WIDTH
    // refX = 0 positions the tip at the line start point
    return `<marker id="${id}" markerWidth="${ARROW_WIDTH}" markerHeight="${ARROW_HEIGHT}" refX="0" refY="${ARROW_HEIGHT / 2}" orient="auto">
      <polygon points="${ARROW_WIDTH} 0, 0 ${ARROW_HEIGHT / 2}, ${ARROW_WIDTH} ${ARROW_HEIGHT}" fill="${color}"/>
    </marker>`;
  }

  /**
   * Get direction vector for a side
   */
  private getSideDirection(side: string | undefined): { x: number; y: number } {
    switch (side) {
      case 'top':
        return { x: 0, y: -1 };
      case 'bottom':
        return { x: 0, y: 1 };
      case 'left':
        return { x: -1, y: 0 };
      case 'right':
      default:
        return { x: 1, y: 0 };
    }
  }

  private getControlDistanceForDirection(dir: { x: number; y: number }, dx: number, dy: number): number {
    // Use axis-specific distance so a large vertical separation doesn't overly "push" a horizontal curve (and vice versa).
    const axisDist = Math.abs(dir.x) > 0 ? dx : dy;
    return Math.max(80, axisDist * 0.5);
  }

  /**
   * Generate SVG for an edge
   */
  private renderEdge(edge: any, nodeMap: Map<string, any>, offsetX: number, offsetY: number, fontFamily: string): string {
    const fromNode = nodeMap.get(edge.fromNode);
    const toNode = nodeMap.get(edge.toNode);
    
    if (!fromNode || !toNode) return '';
    
    const start = this.getConnectionPoint(fromNode, edge.fromSide, offsetX, offsetY);
    const end = this.getConnectionPoint(toNode, edge.toSide, offsetX, offsetY);
    
    const color = this.getEdgeColor(edge.color);
    const markerId = `arrow-${edge.id}`;
    
    // Calculate control points for bezier curve based on the sides
    // The control point should extend in the direction of the side
    const fromDir = this.getSideDirection(edge.fromSide);
    const toDir = this.getSideDirection(edge.toSide);
    
    // Calculate distance for control point offset
    // Use a larger minimum to ensure curves stay perpendicular to nodes longer
    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    const dist = Math.max(dx, dy);
    // Calculate straight line distance between start and end points
    const straightDist = Math.sqrt(dx * dx + dy * dy);
    
    let svg = '';
    
    // For close nodes, use straight line; for bidirectional arrows need larger threshold
    const hasEndArrow = edge.toEnd === 'arrow' || edge.toEnd === undefined;
    const hasStartArrow = edge.fromEnd === 'arrow';
    const arrowCount = (hasEndArrow ? 1 : 0) + (hasStartArrow ? 1 : 0);
    
    // Use straight line when nodes are close to avoid bezier curve looping through nodes.
    // When controlDist=80 (minimum) but gap<27, the curve's control points extend beyond
    // the gap, causing S-shaped curves that penetrate nodes.
    // Threshold: 30px for all cases (slightly above observed 27px critical point)
    if (straightDist < MIN_DISTANCE_FOR_CURVE) {
      // Calculate arrow scale based on available space
      // For single arrow: arrow can use up to 60% of distance
      // For bidirectional: each arrow gets 40% of distance (total 80%, leaving 20% gap for line)
      let arrowScale = 1;
      if (arrowCount > 0) {
        const maxArrowRatio = arrowCount >= 2 ? 0.4 : 0.6;
        const availablePerArrow = straightDist * maxArrowRatio;
        if (availablePerArrow < ARROW_WIDTH) {
          arrowScale = availablePerArrow / ARROW_WIDTH;
        }
      }
      
      // Use scaled marker IDs for close nodes
      const scaledMarkerId = `${markerId}-scaled`;
      const markerEnd = hasEndArrow ? `marker-end="url(#${scaledMarkerId})"` : '';
      const markerStart = hasStartArrow ? `marker-start="url(#${scaledMarkerId}-start)"` : '';
      
      // Generate inline scaled markers for this edge
      const scaledW = ARROW_WIDTH * arrowScale;
      const scaledH = ARROW_HEIGHT * arrowScale;
      
      let markers = '';
      if (hasEndArrow) {
        markers += `<defs><marker id="${scaledMarkerId}" markerWidth="${scaledW}" markerHeight="${scaledH}" refX="${scaledW}" refY="${scaledH / 2}" orient="auto" markerUnits="userSpaceOnUse">
          <polygon points="0 0, ${scaledW} ${scaledH / 2}, 0 ${scaledH}" fill="${color}"/>
        </marker></defs>`;
      }
      if (hasStartArrow) {
        // For start arrow, refX=0 positions the tip at line start, base extends along the line
        markers += `<defs><marker id="${scaledMarkerId}-start" markerWidth="${scaledW}" markerHeight="${scaledH}" refX="0" refY="${scaledH / 2}" orient="auto" markerUnits="userSpaceOnUse">
          <polygon points="${scaledW} 0, 0 ${scaledH / 2}, ${scaledW} ${scaledH}" fill="${color}"/>
        </marker></defs>`;
      }
      
      // Draw a straight line between the two points with scaled arrows
      svg += markers;
      svg += `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="${color}" stroke-width="2" ${markerEnd} ${markerStart}/>`;
    } else {
      // For distant nodes, draw the curved path
      // Control distance should be at least 80px, and scale with distance.
      // Use axis-specific distance to avoid excessive bulges on long diagonal links.
      const fromControlDist = this.getControlDistanceForDirection(fromDir, dx, dy);
      const toControlDist = this.getControlDistanceForDirection(toDir, dx, dy);
      
      // Control points extend from start/end in the direction of their sides
      const cp1x = start.x + fromDir.x * fromControlDist;
      const cp1y = start.y + fromDir.y * fromControlDist;
      const cp2x = end.x + toDir.x * toControlDist;
      const cp2y = end.y + toDir.y * toControlDist;
      
      // Draw the path (markers are defined in <defs>)
      const markerEnd = (edge.toEnd === 'arrow' || edge.toEnd === undefined) ? `marker-end="url(#${markerId})"` : '';
      const markerStart = edge.fromEnd === 'arrow' ? `marker-start="url(#${markerId}-start)"` : '';
      
      svg += `<path d="M${start.x},${start.y} C${cp1x},${cp1y} ${cp2x},${cp2y} ${end.x},${end.y}" fill="none" stroke="${color}" stroke-width="2" ${markerEnd} ${markerStart}/>`;
    }
    
    // Edge label
    if (edge.label) {
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2 - 8;
      svg += `<text x="${midX}" y="${midY}" font-family="${fontFamily}" font-size="${LABEL_FONT_SIZE}" fill="${color}" text-anchor="middle">${this.escapeXml(edge.label)}</text>`;
    }
    
    return svg;
  }

  /**
   * Generate complete SVG from JSON Canvas data
   */
  private generateSvg(canvas: any, fontFamily: string): string {
    const nodes = canvas.getNodes();
    const edges = canvas.getEdges();

    // Build node map for edge rendering
    const nodeMap = new Map<string, any>();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }

    // Calculate bounds (include edges so long bezier curves are not clipped)
    const bounds = this.calculateBounds(nodes, edges, nodeMap);
    
    // Sort nodes: groups first (as background), then other nodes
    const sortedNodes = [...nodes].sort((a, b) => {
      if (a.type === 'group' && b.type !== 'group') return -1;
      if (a.type !== 'group' && b.type === 'group') return 1;
      return 0;
    });
    
    // Start SVG
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="0 0 ${bounds.width} ${bounds.height}">`;
    
    // Add defs for markers
    svg += '<defs>';
    for (const edge of edges) {
      const color = this.getEdgeColor(edge.color);
      if (edge.toEnd === 'arrow' || edge.toEnd === undefined) {
        svg += this.getArrowMarker(`arrow-${edge.id}`, color);
      }
      if (edge.fromEnd === 'arrow') {
        svg += this.getArrowMarkerStart(`arrow-${edge.id}-start`, color);
      }
    }
    svg += '</defs>';
    
    // Render edges first (below nodes)
    for (const edge of edges) {
      svg += this.renderEdge(edge, nodeMap, bounds.offsetX, bounds.offsetY, fontFamily);
    }
    
    // Render nodes (on top of edges)
    for (const node of sortedNodes) {
      switch (node.type) {
        case 'text':
          svg += this.renderTextNode(node, bounds.offsetX, bounds.offsetY, fontFamily);
          break;
        case 'file':
          svg += this.renderFileNode(node, bounds.offsetX, bounds.offsetY, fontFamily);
          break;
        case 'link':
          svg += this.renderLinkNode(node, bounds.offsetX, bounds.offsetY, fontFamily);
          break;
        case 'group':
          svg += this.renderGroupNode(node, bounds.offsetX, bounds.offsetY, fontFamily);
          break;
        default:
          // Treat unknown types as text nodes
          svg += this.renderTextNode(node, bounds.offsetX, bounds.offsetY, fontFamily);
      }
    }
    
    svg += '</svg>';
    
    return svg;
  }

  /**
   * Render JSON Canvas to PNG
   * @param jsonStr - JSON Canvas string
   * @param themeConfig - Theme configuration
   * @returns Render result with base64, width, height, format
   */
  async render(jsonStr: string, themeConfig: RendererThemeConfig | null): Promise<RenderResult> {
    // Ensure renderer is initialized
    if (!this._initialized) {
      await this.initialize(themeConfig);
    }

    // Validate input
    this.validateInput(jsonStr);

    // Parse JSON Canvas
    let canvas;
    try {
      canvas = JSONCanvas.fromString(jsonStr);
    } catch (e) {
      throw new Error(`Invalid JSON Canvas format: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Get font family from theme
    const fontFamily = themeConfig?.fontFamily || "'SimSun', 'Times New Roman', Times, serif";

    // Generate SVG
    let svgContent = this.generateSvg(canvas, fontFamily);

    // Apply rough.js hand-drawn effect if enabled
    const isHandDrawn = themeConfig?.diagramStyle === 'handDrawn';
    if (isHandDrawn) {
      svgContent = applyRoughEffect(svgContent, this.roughOptions);
    }

    // Parse SVG to get dimensions
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
    const svgElement = svgDoc.documentElement;

    // Get dimensions from SVG
    let captureWidth: number, captureHeight: number;
    const viewBox = svgElement.getAttribute('viewBox');

    if (viewBox) {
      const parts = viewBox.split(/\s+/);
      captureWidth = Math.ceil(parseFloat(parts[2]));
      captureHeight = Math.ceil(parseFloat(parts[3]));
    } else {
      captureWidth = Math.ceil(parseFloat(svgElement.getAttribute('width') || '800'));
      captureHeight = Math.ceil(parseFloat(svgElement.getAttribute('height') || '600'));
    }

    // Calculate scale for PNG dimensions
    const scale = this.calculateCanvasScale(themeConfig);

    // Render SVG to canvas as PNG
    const pngCanvas = await this.renderSvgToCanvas(
      svgContent,
      captureWidth * scale,
      captureHeight * scale
    );

    const pngDataUrl = pngCanvas.toDataURL('image/png', 1.0);
    const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, '');

    return {
      base64: base64Data,
      width: pngCanvas.width,
      height: pngCanvas.height,
      format: 'png'
    };
  }
}
