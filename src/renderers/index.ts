/**
 * Renderer Registry
 * 
 * Exports all available renderers as an array.
 * New renderers can be added here without modifying other files.
 */
import { MermaidRenderer } from './mermaid-renderer';
import { VegaRenderer } from './vega-renderer';
import { HtmlRenderer } from './html-renderer';
import { SvgRenderer } from './svg-renderer';
import { DotRenderer } from './dot-renderer';
import { InfographicRenderer } from './infographic-renderer';
import { JsonCanvasRenderer } from './canvas-renderer';
import { DrawioRenderer } from './drawio-renderer';
import type { BaseRenderer } from './base-renderer';

// Export renderer instances array
export const renderers: BaseRenderer[] = [
  new MermaidRenderer(),
  new VegaRenderer('vega-lite'),
  new VegaRenderer('vega'),
  new HtmlRenderer(),
  new SvgRenderer(),
  new DotRenderer(),
  new InfographicRenderer(),
  new JsonCanvasRenderer(),
  new DrawioRenderer()
];
