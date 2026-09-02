/**
 * Diagram render contract tests — the shared renderer registry through the
 * CLI pipeline:
 *  - PlantUML produces SVG + PNG + DrawIO XML (draw-uml intermediate),
 *  - Mermaid produces SVG + PNG (no DrawIO XML),
 *  - a theme override applies without breaking the render.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';

import {
  createBrowserRenderHarness,
  type BrowserRenderHarness,
} from '../../helpers/browser-render-harness.ts';

const DIAGRAM_DIR = path.resolve('test/fixtures/diagrams');
const PLANTUML = fs.readFileSync(path.join(DIAGRAM_DIR, 'plantuml.puml'), 'utf8');
const MERMAID = fs.readFileSync(path.join(DIAGRAM_DIR, 'mermaid.mmd'), 'utf8');

const FIXED_PARAMS = {
  theme: 'default',
  timeoutMs: 180_000,
} as const;

describe('diagram render contract (shared renderer registry)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: path.join(DIAGRAM_DIR, 'plantuml.puml') });
  });

  after(async () => {
    await harness.dispose();
  });

  it('renders PlantUML to SVG, PNG and DrawIO XML', async () => {
    const result = await harness.renderDiagram('plantuml', PLANTUML, FIXED_PARAMS);
    assert.ok(result.svg?.includes('<svg'), 'PlantUML must produce SVG');
    assert.ok(
      result.drawioXml && /mxGraphModel|mxfile/.test(result.drawioXml),
      'PlantUML must produce DrawIO XML (draw-uml intermediate)',
    );
    assert.ok(result.pngBase64, 'PlantUML must produce PNG');
    assert.ok(result.width > 0 && result.height > 0, 'dimensions must be resolved');
  });

  it('renders Mermaid to SVG + PNG without DrawIO XML', async () => {
    const result = await harness.renderDiagram('mermaid', MERMAID, FIXED_PARAMS);
    assert.ok(result.svg?.includes('<svg'), 'Mermaid must produce SVG');
    assert.ok(result.pngBase64, 'Mermaid must produce PNG');
    assert.equal(result.drawioXml, undefined, 'Mermaid has no DrawIO representation');
  });

  it('applies a theme override to the render', async () => {
    const result = await harness.renderDiagram('mermaid', MERMAID, { ...FIXED_PARAMS, theme: 'midnight' });
    assert.ok(result.svg?.includes('<svg'), 'themed render must still produce SVG');
    assert.ok(result.width > 0, 'themed render must resolve dimensions');
  });

  it('renders a static SVG file as-is', async () => {
    const svgSource = fs.readFileSync(path.join(DIAGRAM_DIR, 'simple.svg'), 'utf8');
    const result = await harness.renderDiagram('svg', svgSource, FIXED_PARAMS);
    assert.ok(result.svg?.includes('<svg'), 'svg type must pass the source through');
    assert.ok(!result.drawioXml, 'svg type has no DrawIO representation');
  });

  it('renders DrawIO XML to SVG + PNG', async () => {
    const drawioSource = fs.readFileSync(path.join(DIAGRAM_DIR, 'simple.drawio'), 'utf8');
    const result = await harness.renderDiagram('drawio', drawioSource, FIXED_PARAMS);
    assert.ok(result.svg?.includes('<svg'), 'drawio type must produce SVG');
    assert.ok(result.pngBase64, 'drawio type must produce PNG');
  });

  it('renders canvas-first types (echarts / vega-lite) with SVG + PNG', async () => {
    const options = JSON.stringify({ xAxis: { type: 'category', data: ['A', 'B'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [1, 2] }] });
    const echarts = await harness.renderDiagram('echarts', options, FIXED_PARAMS);
    assert.ok(echarts.pngBase64, 'echarts must produce PNG');
    assert.ok(echarts.svg?.includes('<svg'), 'echarts must produce SVG (svg renderer)');

    const vegaLite = JSON.stringify({ $schema: 'https://vega.github.io/schema/vega-lite/v5.json', data: { values: [{ a: 1 }, { a: 2 }] }, mark: 'bar', encoding: { x: { field: 'a', type: 'quantitative' } } });
    const vega = await harness.renderDiagram('vega-lite', vegaLite, FIXED_PARAMS);
    assert.ok(vega.pngBase64, 'vega-lite must produce PNG');
    assert.ok(vega.svg?.includes('<svg'), 'vega-lite must produce SVG (view.toSVG)');
  });

  it('clamps huge SVGs so PNG export never breaks (canvas limits)', async () => {
    const hugeSvg = fs.readFileSync(path.join(DIAGRAM_DIR, 'huge.svg'), 'utf8');
    const result = await harness.renderDiagram('svg', hugeSvg, FIXED_PARAMS);
    assert.ok(result.pngBase64, 'a huge SVG must still produce a valid PNG');
    assert.ok(
      result.width <= 16384 && result.height <= 16384,
      `canvas dimensions must be clamped to Chromium's limits (got ${result.width}×${result.height})`,
    );
    assert.ok(result.width >= 7917, 'the clamp must keep as much resolution as possible');
  });

  it('clamps huge remote SVGs through the URL path (badge-style takeover)', async () => {
    const result = await harness.renderDiagramUrl('svg', 'huge.svg', FIXED_PARAMS);
    assert.ok(result.pngBase64, 'a huge remote SVG must still produce a valid PNG');
    assert.ok(
      result.width <= 16384 && result.height <= 16384,
      `remote URL canvas must be clamped (got ${result.width}×${result.height})`,
    );
  });
});
