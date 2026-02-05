/**
 * Rough SVG Effect
 *
 * Applies hand-drawn effect to SVG elements using rough.js
 * Processes borders, lines, and fills while preserving text
 */
import rough from 'roughjs';

export interface RoughSvgOptions {
  /** Roughness of hand-drawn effect (0 = smooth, 1+ = rough) */
  roughness?: number;
  /** Bowing of lines (0 = straight, 1+ = curved) */
  bowing?: number;
  /** Fill style for shapes */
  fillStyle?: 'hachure' | 'solid' | 'zigzag' | 'cross-hatch' | 'dots' | 'dashed' | 'zigzag-line';
  /** Weight of fill lines */
  fillWeight?: number;
  /** Gap between fill lines */
  hachureGap?: number;
  /** Default border color when none specified */
  defaultBorderColor?: string;
  /** Only process markers (arrows), skip other elements */
  markersOnly?: boolean;
}

const DEFAULT_OPTIONS: Required<RoughSvgOptions> = {
  roughness: 0.5,
  bowing: 0.5,
  fillStyle: 'hachure',
  fillWeight: 0.5,
  hachureGap: 4,
  defaultBorderColor: '#333',
  markersOnly: false,
};

/**
 * Apply rough.js hand-drawn effect to SVG string
 * @param svgString - Original SVG string
 * @param options - Rough.js options
 * @returns SVG string with hand-drawn effect applied
 */
export function applyRoughEffect(svgString: string, options: RoughSvgOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const roughOptions = {
    roughness: opts.roughness,
    bowing: opts.bowing,
  };

  // Use innerHTML to parse SVG so browser correctly processes internal <style> tags
  const tempContainer = document.createElement('div');
  tempContainer.style.cssText = 'position: absolute; left: -9999px; top: -9999px;';
  tempContainer.innerHTML = svgString;
  document.body.appendChild(tempContainer);

  const svgElement = tempContainer.querySelector('svg') as unknown as SVGSVGElement;
  if (!svgElement) {
    document.body.removeChild(tempContainer);
    return svgString;
  }

  const rc = rough.svg(svgElement);

  // Helper to get stroke color (from attribute or computed style)
  const getStroke = (el: SVGElement): string | null => {
    const attr = el.getAttribute('stroke');
    if (attr && attr !== 'none') return attr;
    const computed = window.getComputedStyle(el).stroke;
    if (computed && computed !== 'none' && computed !== '') return computed;
    return null;
  };

  // Helper to get fill color (from attribute or computed style)
  const getFill = (el: SVGElement): string | null => {
    const attr = el.getAttribute('fill');
    if (attr && attr !== 'none') return attr;
    const computed = window.getComputedStyle(el).fill;
    if (computed && computed !== 'none' && computed !== '') return computed;
    return null;
  };

  // Helper to remove stroke from element
  const removeStroke = (el: SVGElement): void => {
    el.setAttribute('stroke', 'none');
    el.style.stroke = 'none';
  };

  // Helper to check if element is inside defs or marker (arrows, etc.)
  const isInsideDefsOrMarker = (el: Element): boolean => {
    let parent = el.parentElement;
    while (parent) {
      const tagName = parent.tagName.toLowerCase();
      if (tagName === 'defs' || tagName === 'marker') return true;
      parent = parent.parentElement;
    }
    return false;
  };

  // If markersOnly is true, skip to marker processing
  if (!opts.markersOnly) {

  // Process rect elements
  svgElement.querySelectorAll('rect').forEach(rect => {
    if (isInsideDefsOrMarker(rect)) return;

    const stroke = getStroke(rect as SVGElement);
    const fill = getFill(rect as SVGElement);

    if (!stroke && !fill) return;

    const x = parseFloat(rect.getAttribute('x') || '0');
    const y = parseFloat(rect.getAttribute('y') || '0');
    const width = parseFloat(rect.getAttribute('width') || '0');
    const height = parseFloat(rect.getAttribute('height') || '0');
    if (width <= 0 || height <= 0) return;

    const borderColor = stroke || opts.defaultBorderColor;

    const node = rc.rectangle(x, y, width, height, {
      ...roughOptions,
      stroke: borderColor,
      fill: fill || 'none',
      fillStyle: opts.fillStyle,
      fillWeight: opts.fillWeight,
      hachureGap: opts.hachureGap,
    });

    rect.parentNode?.insertBefore(node, rect);
    rect.remove();
  });

  // Process circle elements
  svgElement.querySelectorAll('circle').forEach(circle => {
    if (isInsideDefsOrMarker(circle)) return;

    const stroke = getStroke(circle as SVGElement);
    const fill = getFill(circle as SVGElement);

    if (!stroke && !fill) return;

    const cx = parseFloat(circle.getAttribute('cx') || '0');
    const cy = parseFloat(circle.getAttribute('cy') || '0');
    const r = parseFloat(circle.getAttribute('r') || '0');
    if (r <= 0) return;

    const borderColor = stroke || opts.defaultBorderColor;

    const node = rc.circle(cx, cy, r * 2, {
      ...roughOptions,
      stroke: borderColor,
      fill: fill || 'none',
      fillStyle: opts.fillStyle,
      fillWeight: opts.fillWeight,
      hachureGap: opts.hachureGap,
    });

    circle.parentNode?.insertBefore(node, circle);
    circle.remove();
  });

  // Process ellipse elements
  svgElement.querySelectorAll('ellipse').forEach(ellipse => {
    if (isInsideDefsOrMarker(ellipse)) return;

    const stroke = getStroke(ellipse as SVGElement);
    const fill = getFill(ellipse as SVGElement);

    if (!stroke && !fill) return;

    const cx = parseFloat(ellipse.getAttribute('cx') || '0');
    const cy = parseFloat(ellipse.getAttribute('cy') || '0');
    const rx = parseFloat(ellipse.getAttribute('rx') || '0');
    const ry = parseFloat(ellipse.getAttribute('ry') || '0');
    if (rx <= 0 || ry <= 0) return;

    const borderColor = stroke || opts.defaultBorderColor;

    const node = rc.ellipse(cx, cy, rx * 2, ry * 2, {
      ...roughOptions,
      stroke: borderColor,
      fill: fill || 'none',
      fillStyle: opts.fillStyle,
      fillWeight: opts.fillWeight,
      hachureGap: opts.hachureGap,
    });

    ellipse.parentNode?.insertBefore(node, ellipse);
    ellipse.remove();
  });

  // Process polygon elements
  svgElement.querySelectorAll('polygon').forEach(polygon => {
    if (isInsideDefsOrMarker(polygon)) return;

    const stroke = getStroke(polygon as SVGElement);
    const fill = getFill(polygon as SVGElement);

    if (!stroke && !fill) return;

    const pointsStr = polygon.getAttribute('points') || '';
    const points: [number, number][] = pointsStr.trim().split(/\s+/).map(p => {
      const [x, y] = p.split(',').map(Number);
      return [x, y] as [number, number];
    });
    if (points.length < 3) return;

    const borderColor = stroke || opts.defaultBorderColor;

    const node = rc.polygon(points, {
      ...roughOptions,
      stroke: borderColor,
      fill: fill || 'none',
      fillStyle: opts.fillStyle,
      fillWeight: opts.fillWeight,
      hachureGap: opts.hachureGap,
    });

    polygon.parentNode?.insertBefore(node, polygon);
    polygon.remove();
  });

  // Process line elements
  svgElement.querySelectorAll('line').forEach(line => {
    if (isInsideDefsOrMarker(line)) return;

    const stroke = getStroke(line as SVGElement);
    if (!stroke) return;

    const x1 = parseFloat(line.getAttribute('x1') || '0');
    const y1 = parseFloat(line.getAttribute('y1') || '0');
    const x2 = parseFloat(line.getAttribute('x2') || '0');
    const y2 = parseFloat(line.getAttribute('y2') || '0');

    const node = rc.line(x1, y1, x2, y2, {
      ...roughOptions,
      stroke: stroke,
    });

    // If line has marker-end (arrow), keep original line but make it invisible
    const markerEnd = line.getAttribute('marker-end');
    const markerStart = line.getAttribute('marker-start');
    if (markerEnd || markerStart) {
      removeStroke(line as SVGElement);
      line.parentNode?.insertBefore(node, line);
    } else {
      line.parentNode?.replaceChild(node, line);
    }
  });

  // Process path elements (connection lines)
  svgElement.querySelectorAll('path').forEach(path => {
    if (isInsideDefsOrMarker(path)) return;

    const stroke = getStroke(path as SVGElement);
    const fill = getFill(path as SVGElement);
    const d = path.getAttribute('d');

    // Only process paths that are lines (have stroke, no fill or transparent fill)
    if (!stroke || !d) return;
    if (fill && fill !== 'rgb(0, 0, 0)') return;

    const node = rc.path(d, {
      ...roughOptions,
      stroke: stroke,
      fill: 'none',
    });

    // If path has marker-end (arrow), keep original path but make it invisible
    const markerEnd = path.getAttribute('marker-end');
    const markerStart = path.getAttribute('marker-start');
    if (markerEnd || markerStart) {
      removeStroke(path as SVGElement);
      path.parentNode?.insertBefore(node, path);
    } else {
      path.parentNode?.replaceChild(node, path);
    }
  });

  } // end of !markersOnly block

  // Process marker elements (arrow heads)
  const insertRoughNode = (node: SVGGElement, parent: Element, reference: Element): void => {
    const paths = node.querySelectorAll('path');
    if (paths.length === 0) {
      parent.insertBefore(node, reference);
      return;
    }
    paths.forEach(p => parent.insertBefore(p.cloneNode(true), reference));
  };

  svgElement.querySelectorAll('marker path').forEach(path => {
    const stroke = getStroke(path as SVGElement) || opts.defaultBorderColor;
    const fill = getFill(path as SVGElement);
    const d = path.getAttribute('d');
    if (!d) return;

    const node = rc.path(d, {
      ...roughOptions,
      stroke,
      fill: fill || 'none',
      fillStyle: 'hachure',
      fillWeight: opts.fillWeight,
      hachureGap: opts.hachureGap,
    });

    insertRoughNode(node, path.parentNode!, path);
    path.remove();
  });

  // Remove from DOM and serialize
  document.body.removeChild(tempContainer);
  return new XMLSerializer().serializeToString(svgElement);
}
