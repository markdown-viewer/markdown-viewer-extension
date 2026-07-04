# GitHub Alerts 演示 / GitHub Alerts Demo

This document demonstrates support for [GitHub-style alert syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts).

Alerts are blockquotes whose first line is a marker such as `> [!NOTE]`. The marker must be on its own line; the supported kinds are `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, and `CAUTION` (matched case-insensitively).

---

> [!NOTE]
> Useful information that users should know, even when skimming content.

> [!TIP]
> Helpful advice for doing things better or more easily.

> [!IMPORTANT]
> Key information users need to be aware of to achieve their goal.

> [!WARNING]
> Urgent information that needs immediate user attention to avoid problems.

> [!CAUTION]
> Advises about risks or negative outcomes of certain actions.

## Multi-paragraph body

> [!WARNING]
> The first paragraph of the alert body.
>
> A second paragraph — note the blank `>` line separating them.

## Inline formatting inside alerts

> [!TIP]
> Alerts preserve inline formatting such as **bold**, *italic*, `code`, and [links](https://example.com).

## Marker only (no body)

> [!NOTE]

## Lists inside alerts

> [!IMPORTANT]
> Alerts can contain any block content, including lists:
>
> - First item
> - Second item
> - Third item

## Not an alert

The following is a normal blockquote, because the marker is not on its own line:

> [!NOTE] this is not an alert, just a blockquote.

And a plain blockquote stays untouched:

> Just a regular blockquote with no marker.
