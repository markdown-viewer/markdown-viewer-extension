declare module 'dagre' {
  export interface Graph {
    setNode(id: string, label?: unknown): void;
    setEdge(source: string, target: string, label?: unknown): void;
    node(id: string): unknown;
    nodes(): string[];
    edges(): Array<{ v: string; w: string; name?: string }>;
  }

  export interface Graphlib {
    Graph: new (config?: Record<string, unknown>) => Graph;
    json: {
      read(json: unknown): Graph;
      write(graph: Graph): unknown;
    };
    alg: {
      [algorithm: string]: (...args: unknown[]) => unknown;
    };
  }

  export interface Layout {
    (graph: Graph, layoutOptions?: Record<string, unknown>): void;
  }

  interface Dagre {
    graphlib: Graphlib;
    layout: Layout;
    debug: (...args: unknown[]) => void;
    util: {
      time: <T>(name: string, fn: () => T) => T;
      notime: <T>(name: string, fn: () => T) => T;
    };
    version: string;
  }

  const dagre: Dagre;
  export default dagre;
}
