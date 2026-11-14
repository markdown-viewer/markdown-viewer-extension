# Reference Fixture

Full reference: [Example Site][site]

Collapsed reference: [site][]

Shortcut reference: [site]

Reference image: ![Logo][logo]

Reference image inside a reference link: [![Logo][logo]][site]

Reference image inside an inline link: [![Logo][logo]](https://example.com/inline)

Nested reference in a table:

| Item | Link |
|------|------|
| Docs | [Example Site][site] |
| Logo | ![Logo][logo] |

A reference whose definition never appears stays literal:

[Undefined][missing-label]

<!-- Definitions live here, in separate blocks from every reference above. -->

[site]: https://example.com/docs

[logo]: ./assets/icon48.png
