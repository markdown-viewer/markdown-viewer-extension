/**
 * JSON Canvas Renderer Tests
 * 
 * Tests for the JSON Canvas to SVG rendering functionality.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JSONCanvas from '@trbn/jsoncanvas';
import { JsonCanvasRenderer } from '../src/renderers/canvas-renderer.ts';

// Create renderer instance for testing
const renderer = new JsonCanvasRenderer();

// Helper to extract SVG content via private method
function generateSvg(canvasData: object): string {
  const code = JSON.stringify(canvasData);
  const canvas = JSONCanvas.fromString(code);
  return (renderer as any)['generateSvg'](canvas, 'sans-serif');
}

describe('JsonCanvasRenderer', () => {
  describe('initialization', () => {
    it('should initialize successfully', async () => {
      const r = new JsonCanvasRenderer();
      await r.initialize();
      assert.ok(true, 'Renderer should initialize without error');
    });

    it('should have correct renderer type', () => {
      assert.strictEqual(renderer.type, 'canvas');
    });
  });

  describe('node rendering', () => {
    it('should render text node', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: 'Hello', x: 0, y: 0, width: 100, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('<rect'), 'Should contain rect element');
      assert.ok(svg.includes('Hello'), 'Should contain text content');
      assert.ok(svg.includes('rx="8"'), 'Should have rounded corners');
    });

    it('should render file node', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'file', file: 'document.pdf', x: 0, y: 0, width: 100, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('<rect'), 'Should contain rect element');
      assert.ok(svg.includes('document.pdf'), 'Should contain file name');
    });

    it('should render link node', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'link', url: 'https://example.com', x: 0, y: 0, width: 100, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('<rect'), 'Should contain rect element');
      assert.ok(svg.includes('example.com'), 'Should contain URL');
    });

    it('should render group node', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'group', label: 'My Group', x: 0, y: 0, width: 200, height: 150 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('<rect'), 'Should contain rect element');
      assert.ok(svg.includes('My Group'), 'Should contain group label');
    });

    it('should render multiple nodes', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'n2', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 60 },
          { id: 'n3', type: 'text', text: 'C', x: 400, y: 0, width: 100, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('>A<'), 'Should contain node A');
      assert.ok(svg.includes('>B<'), 'Should contain node B');
      assert.ok(svg.includes('>C<'), 'Should contain node C');
    });
  });

  describe('node colors', () => {
    it('should apply color preset 1 (red)', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: 'Red', x: 0, y: 0, width: 100, height: 60, color: '1' }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('stroke="#e76f6f"'), 'Should have red stroke color');
    });

    it('should apply color preset 6 (purple)', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: 'Purple', x: 0, y: 0, width: 100, height: 60, color: '6' }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('stroke="#9f8fcc"'), 'Should have purple stroke color');
    });

    it('should apply hex color', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: 'Custom', x: 0, y: 0, width: 100, height: 60, color: '#ff5500' }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('stroke="#ff5500"'), 'Should have custom hex stroke color');
    });
  });

  describe('edge rendering', () => {
    it('should render edge with default arrow (toEnd)', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' }
        ]
      });
      
      assert.ok(svg.includes('<path'), 'Should contain path element');
      assert.ok(svg.includes('marker-end="url(#arrow-e1)"'), 'Should have end arrow marker');
    });

    it('should render edge without arrows (toEnd: none)', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', toEnd: 'none' }
        ]
      });
      
      assert.ok(svg.includes('<path'), 'Should contain path element');
      assert.ok(!svg.includes('marker-end'), 'Should not have end arrow marker');
    });

    it('should render bidirectional edge (fromEnd: arrow, toEnd: arrow)', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', fromEnd: 'arrow', toEnd: 'arrow' }
        ]
      });
      
      assert.ok(svg.includes('marker-end="url(#arrow-e1)"'), 'Should have end arrow marker');
      assert.ok(svg.includes('marker-start="url(#arrow-e1-start)"'), 'Should have start arrow marker');
    });

    it('should render edge label', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', label: 'connects' }
        ]
      });
      
      assert.ok(svg.includes('>connects<'), 'Should contain edge label');
    });

    it('should render colored edge', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', color: '1' }
        ]
      });
      
      assert.ok(svg.includes('stroke="#e76f6f"'), 'Should have red stroke on path');
    });
  });

  describe('arrow markers', () => {
    it('should define end arrow marker with correct refX (not overlapping node)', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' }
        ]
      });
      
      // End arrow: refX=ARROW_WIDTH means tip at endpoint
      assert.ok(svg.includes('id="arrow-e1"'), 'Should have arrow marker defined');
      assert.ok(svg.includes('refX="7"'), 'End arrow should have refX=7');
      assert.ok(svg.includes('points="0 0, 7 3, 0 6"'), 'End arrow should point right');
    });

    it('should define start arrow marker pointing toward start node', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', fromEnd: 'arrow' }
        ]
      });
      
      // Start arrow: refX=0 positions the tip at line start, base extends along the line
      assert.ok(svg.includes('id="arrow-e1-start"'), 'Should have start arrow marker defined');
      assert.ok(svg.includes('refX="0"'), 'Start arrow should have refX=0');
      assert.ok(svg.includes('points="7 0, 0 3, 7 6"'), 'Start arrow should point left (toward start)');
    });
  });

  describe('edge connection sides', () => {
    it('should connect from right side', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' }
        ]
      });
      
      // Path should start at x=140 (0+100+40 offset) and connect to x=240 (200+40 offset)
      assert.ok(svg.includes('M140,'), 'Path should start from right side of node A');
    });

    it('should connect from bottom to top', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 0, y: 150, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'bottom', toNode: 'b', toSide: 'top' }
        ]
      });
      
      assert.ok(svg.includes('<path'), 'Should render vertical edge');
    });
  });

  describe('SVG structure', () => {
    it('should have valid SVG structure', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: 'Test', x: 0, y: 0, width: 100, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.startsWith('<svg'), 'Should start with svg tag');
      assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'Should have SVG namespace');
      assert.ok(svg.includes('viewBox='), 'Should have viewBox');
      assert.ok(svg.endsWith('</svg>'), 'Should end with closing svg tag');
    });

    it('should include defs section for markers', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' }
        ]
      });
      
      assert.ok(svg.includes('<defs>'), 'Should have defs section');
      assert.ok(svg.includes('</defs>'), 'Should close defs section');
      assert.ok(svg.includes('<marker'), 'Should contain marker definitions');
    });

    it('should not have white background (transparent canvas)', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: 'Test', x: 0, y: 0, width: 100, height: 60 }
        ],
        edges: []
      });
      
      // Canvas should be transparent, no full-canvas white background rect
      assert.ok(!svg.includes('<rect width="') || !svg.match(/<rect width="[^"]*" height="[^"]*" fill="white"/), 'Should not have full-canvas white background');
    });
  });

  describe('bounds calculation', () => {
    it('should calculate correct canvas dimensions', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'n2', type: 'text', text: 'B', x: 200, y: 100, width: 100, height: 60 }
        ],
        edges: []
      });
      
      // Expected: maxX=300, maxY=160, + padding*2 = 380 x 240
      assert.ok(svg.includes('width="380"'), 'Should have correct width');
      assert.ok(svg.includes('height="240"'), 'Should have correct height');
    });

    it('should include bezier control points in bounds to avoid clipping', () => {
      // A right->right long edge has control points extending beyond node bounds.
      // If bounds are computed from nodes only, the curve gets clipped on the right side.
      const svg = generateSvg({
        nodes: [
          { id: 'kickoff', type: 'text', text: 'Start', x: 0, y: 0, width: 100, height: 60 },
          { id: 'operate', type: 'text', text: 'End', x: 390, y: 630, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'operate', fromSide: 'right', toNode: 'kickoff', toSide: 'right' }
        ]
      });

      const match = svg.match(/width="(\d+)"/);
      assert.ok(match, 'Should have width attribute');
      const width = parseInt(match![1], 10);
      // Node-only width would be 490 + padding*2 = 570. The curve should increase bounds beyond that.
      assert.ok(width > 620, `Expected SVG width to include curve (avoid clipping), got width=${width}`);
    });

    it('should handle negative coordinates', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: 'A', x: -50, y: -30, width: 100, height: 60 }
        ],
        edges: []
      });
      
      // Should still render correctly with offset
      assert.ok(svg.includes('<svg'), 'Should render SVG');
      assert.ok(svg.includes('<rect'), 'Should contain node rect');
    });
  });

  describe('text escaping', () => {
    it('should escape special XML characters in text', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: '<script>alert("xss")</script>', x: 0, y: 0, width: 200, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(!svg.includes('<script>'), 'Should escape < character');
      assert.ok(svg.includes('&lt;script&gt;'), 'Should contain escaped text');
    });

    it('should escape ampersand', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: 'A & B', x: 0, y: 0, width: 100, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('A &amp; B'), 'Should escape ampersand');
    });
  });

  describe('empty canvas', () => {
    it('should handle empty nodes array', () => {
      const svg = generateSvg({
        nodes: [],
        edges: []
      });
      
      assert.ok(svg.includes('<svg'), 'Should still render SVG');
    });
  });

  describe('close nodes edge rendering', () => {
    it('should handle vertical nodes with small gap using straight line', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 0, y: 70, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'bottom', toNode: 'b', toSide: 'top' }
        ]
      });
      
      // For close nodes (distance < 80px), should use straight line instead of bezier curve
      assert.ok(svg.includes('<line'), 'Should have line element for close nodes');
      assert.ok(svg.includes('marker-end='), 'Should have end marker');
    });

    it('should handle horizontal nodes with small gap using straight line', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 110, y: 0, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' }
        ]
      });
      
      // For close nodes (distance < 80px), should use straight line instead of bezier curve
      assert.ok(svg.includes('<line'), 'Should have line element for close nodes');
      assert.ok(svg.includes('marker-end='), 'Should have end marker');
    });

    it('should use bezier curve for distant nodes', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' }
        ]
      });
      
      // For distant nodes (distance >= 80px), should use bezier curve
      assert.ok(svg.includes('<path'), 'Should have path element for distant nodes');
      assert.ok(svg.includes('C'), 'Should have cubic bezier');
      assert.ok(svg.includes('marker-end='), 'Should have end marker');
    });

    it('should scale down arrows when distance is less than arrow width', () => {
      // Nodes with only 5px gap (less than ARROW_WIDTH=7)
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 0, y: 65, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'bottom', toNode: 'b', toSide: 'top' }
        ]
      });
      
      // Should use scaled marker for very close nodes
      assert.ok(svg.includes('arrow-e1-scaled'), 'Should have scaled marker ID for close nodes');
      assert.ok(svg.includes('markerUnits="userSpaceOnUse"'), 'Scaled markers should use userSpaceOnUse');
    });

    it('should scale single arrow to 60% of distance', () => {
      // 10px gap, single arrow should be 10 * 0.6 = 6px
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 0, y: 70, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'bottom', toNode: 'b', toSide: 'top', toEnd: 'arrow' }
        ]
      });
      
      // Single arrow: 10px * 0.6 = 6px width
      assert.ok(svg.includes('markerWidth="6"'), 'Single arrow should be scaled to 6px (60% of 10px)');
    });

    it('should scale bidirectional arrows to 40% of distance each', () => {
      // 10px gap, each arrow should be 10 * 0.4 = 4px (total 80%, leaving 20% gap)
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 0, y: 70, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'bottom', toNode: 'b', toSide: 'top', fromEnd: 'arrow', toEnd: 'arrow' }
        ]
      });
      
      // Bidirectional: each arrow 10px * 0.4 = 4px width
      assert.ok(svg.includes('markerWidth="4"'), 'Bidirectional arrows should be scaled to 4px each (40% of 10px)');
      // Both arrows should have same size
      const matches = svg.match(/markerWidth="4"/g);
      assert.strictEqual(matches?.length, 2, 'Both arrows should have 4px width');
    });

    it('should use straight line for 25px gap to avoid bezier penetration', () => {
      // At 25px gap: controlDist=80 >> gap causes S-shaped curve to penetrate nodes
      // minDistanceForCurve=30 prevents this by using straight line for gap < 30px
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 80, height: 40 },
          { id: 'b', type: 'text', text: 'B', x: 0, y: 65, width: 80, height: 40 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'bottom', toNode: 'b', toSide: 'top', toEnd: 'none' }
        ]
      });
      
      // gap = 65 - 40 = 25px, should use straight line
      assert.ok(svg.includes('<line'), 'Should use straight line for 25px gap (< 30px threshold)');
      assert.ok(!svg.includes('<path'), 'Should not use bezier curve for 25px gap');
    });

    it('should use bezier curve for 30px gap', () => {
      // At 30px gap: exactly at minDistanceForCurve threshold, should start using curves
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 80, height: 40 },
          { id: 'b', type: 'text', text: 'B', x: 0, y: 70, width: 80, height: 40 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'bottom', toNode: 'b', toSide: 'top', toEnd: 'none' }
        ]
      });
      
      // gap = 70 - 40 = 30px, should use bezier curve
      assert.ok(svg.includes('<path'), 'Should use bezier curve for 30px gap (>= 30px threshold)');
    });

    it('should scale arrows for bidirectional edges when distance is less than double arrow width', () => {
      // Nodes with 10px gap, bidirectional arrows need 14px total
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 0, y: 70, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'bottom', toNode: 'b', toSide: 'top', fromEnd: 'arrow', toEnd: 'arrow' }
        ]
      });
      
      // Should use scaled markers for bidirectional arrows that don't fit
      assert.ok(svg.includes('arrow-e1-scaled'), 'Should have scaled end marker');
      assert.ok(svg.includes('arrow-e1-scaled-start'), 'Should have scaled start marker');
    });

    it('should use normal size arrows when distance is sufficient', () => {
      // Nodes with 40px gap (more than minDistanceForCurve=30)
      const svg = generateSvg({
        nodes: [
          { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 60 },
          { id: 'b', type: 'text', text: 'B', x: 0, y: 100, width: 100, height: 60 }
        ],
        edges: [
          { id: 'e1', fromNode: 'a', fromSide: 'bottom', toNode: 'b', toSide: 'top' }
        ]
      });
      
      // Distance is 40px which is >= 30px threshold, should use bezier curve with normal markers
      // The normal markers are defined in defs section
      assert.ok(svg.includes('id="arrow-e1"'), 'Should have normal marker defined in defs');
      assert.ok(!svg.includes('arrow-e1-scaled'), 'Should not have scaled marker for sufficient distance');
    });
  });

  describe('inline markdown rendering', () => {
    it('should render heading with #', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: '# Main Title', x: 0, y: 0, width: 200, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('<h1'), 'Should render H1 tag');
      assert.ok(svg.includes('Main Title'), 'Should contain heading text');
    });

    it('should render bold text with **', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: '**bold text**', x: 0, y: 0, width: 200, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('<strong>bold text</strong>'), 'Should render bold with strong tags');
    });

    it('should render italic text with *', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: '*italic text*', x: 0, y: 0, width: 200, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('<em>italic text</em>'), 'Should render italic with em tags');
    });

    it('should render inline code with backticks', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: 'Use `code` here', x: 0, y: 0, width: 200, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('<code'), 'Should render code with code tags');
      assert.ok(svg.includes('>code</code>'), 'Should contain the code content');
    });

    it('should render strikethrough with ~~', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: '~~deleted~~', x: 0, y: 0, width: 200, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('<del>deleted</del>'), 'Should render strikethrough with del tags');
    });

    it('should render links', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: '[Link](https://example.com)', x: 0, y: 0, width: 200, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('<a href="https://example.com"'), 'Should render link with href');
      assert.ok(svg.includes('>Link</a>'), 'Should contain link text');
    });

    it('should render mixed markdown', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: '**Bold** and *italic* with `code`', x: 0, y: 0, width: 300, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('<strong>Bold</strong>'), 'Should render bold');
      assert.ok(svg.includes('<em>italic</em>'), 'Should render italic');
      assert.ok(svg.includes('>code</code>'), 'Should render code');
    });

    it('should preserve plain text without markdown', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: 'Plain text only', x: 0, y: 0, width: 200, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('Plain text only'), 'Should contain plain text');
      assert.ok(!svg.includes('<strong>'), 'Should not have bold tags');
      assert.ok(!svg.includes('<em>'), 'Should not have italic tags');
    });

    it('should escape HTML in markdown content', () => {
      const svg = generateSvg({
        nodes: [
          { id: 'n1', type: 'text', text: '**<script>alert(1)</script>**', x: 0, y: 0, width: 200, height: 60 }
        ],
        edges: []
      });
      
      assert.ok(svg.includes('&lt;script&gt;'), 'Should escape HTML inside markdown');
      assert.ok(!svg.includes('<script>'), 'Should not contain raw script tags');
    });
  });
});
