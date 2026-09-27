/// Markdown fixtures for the mobile E2E suites.
///
/// Kept inline (not on disk) on purpose: an integration test runs inside the app
/// sandbox on a device/emulator, where "read a file from the repo" is exactly the
/// thing being tested elsewhere. Inline strings keep these suites independent of
/// the app's file-access path, so a failure here means the *render* pipeline
/// broke, not the fixture plumbing.
library;

/// Smallest document that still goes through the full pipeline.
const String kMinimalDocument = '''
# E2E heading

A paragraph with **bold**, _emphasis_ and `inline code`.
''';

/// Markdown structures that must render without any diagram engine involved.
const String kStructureDocument = '''
# Structure

| Column A | Column B |
| --- | --- |
| cell 1 | cell 2 |

```js
const answer = 42;
console.log(answer);
```

- [ ] pending task
- [x] done task

Inline math: \$E = mc^2\$

> A blockquote with a [link](https://example.com).
''';

/// One valid Mermaid diagram (renders through the diagram engine to PNG).
const String kMermaidDocument = '''
# Diagram

```mermaid
graph LR
  A[Start] --> B{Choice}
  B -->|yes| C[Done]
  B -->|no| A
```
''';

/// Two diagrams: used for "all blocks finished" and concurrency checks.
const String kTwoDiagramDocument = '''
# Two diagrams

```mermaid
graph TD
  A1 --> B1
```

```mermaid
sequenceDiagram
  participant P as Phone
  participant H as Host
  P->>H: render
  H-->>P: png
```
''';

/// One broken Mermaid diagram: the pipeline must surface an error block instead
/// of dropping the content silently.
const String kBrokenDiagramDocument = '''
# Broken diagram

```mermaid
graph LR
  A[unterminated --> B
```
''';

/// Deliberately large diagram: a wide graph whose rasterized PNG is megabytes
/// (the payload that exercises chunked transport on Android).
///
/// Gated behind `MV_E2E_HEAVY=1` — on an emulator this is the most expensive case
/// in the suite, and on a starved guest it invites system ANRs instead of
/// failures.
String heavyDiagramDocument({int nodes = 40}) {
  final buffer = StringBuffer('# Heavy diagram\n\n```mermaid\ngraph LR\n');
  for (var i = 0; i < nodes; i++) {
    buffer.writeln('  N$i[Node $i with a reasonably long label] --> N${i + 1}[Node ${i + 1}]');
  }
  buffer.writeln('```\n');
  return buffer.toString();
}
