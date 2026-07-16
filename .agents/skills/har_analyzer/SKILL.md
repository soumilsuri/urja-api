---
name: har_analyzer
description: Instructions for analyzing HAR (HTTP Archive) files using the har-analyzer tool
---

# HAR Analyzer

Token-efficient HAR (HTTP Archive) file analysis with reference system. Use when a user provides a HAR file, asks to analyze network traffic, debug API calls, investigate HTTP requests/responses, or review web performance.

## Critical Rule

**Never** `cat`, `jq`, or directly read a HAR file. Always use the HAR analyzer commands.

## Optimal Workflow

```bash
tools har-analyzer load <file.har>
tools har-analyzer list --status 4xx
tools har-analyzer domain <domain>
tools har-analyzer show e14
tools har-analyzer show e14 --raw
tools har-analyzer expand e14.rs.body
```

## Commands

| Command | Purpose | Key Options |
|---|---|---|
| `load <file>` | Parse HAR and show dashboard | |
| `dashboard` | Show overview stats | |
| `list` | Compact entry table | `--domain --status --method --url --limit` |
| `show <eN>` | Entry detail | `--raw --section body\|headers\|cookies` |
| `expand <ref>` | Show referenced data | `--schema skeleton\|typescript\|schema` |
| `domains` | List domains with stats | |
| `domain <name>` | Drill into a domain | `--status --method` |
| `search <query>` | Search entries | `--scope url\|body\|header\|all` |
| `errors` | Show 4xx/5xx responses | |
| `waterfall` | ASCII timing chart | `--domain --limit` |
| `security` | Detect JWTs, API keys, insecure cookies | |
| `size` | Bandwidth breakdown | |
| `headers` | Header analysis | `--scope request\|response\|both` |
| `redirects` | Redirect tracking | |
| `cookies` | Cookie flow | |
| `diff <e1> <e2>` | Compare requests | |
| `export` | Export HAR subset | `--sanitize --strip-bodies -o file` |

## Global Options

| Flag | Purpose |
|---|---|
| `--format md\|json\|toon` | Output format |
| `--full` | Disable reference system |
| `--include-all` | Include CSS/JS/image/font bodies |

## Reference System

- Large values (>200 chars) are stored as references.
- Example:
  - First display: `[ref:e14.rs.body]`
  - Later display: `[ref:e14.rs.body] ... (1.8KB)`
- Expand with:
  ```bash
  tools har-analyzer expand e14.rs.body
  ```
- Reference format:
  ```
  e{N}.{rq|rs}.{body|headers|cookies}
  ```

## Content Skipping

By default, CSS, JS, images, fonts, and WASM bodies are skipped. Use `--include-all` to include them.

## Common Patterns

### Understand API Shape

```bash
tools har-analyzer expand e14.rs.body --schema
tools har-analyzer expand e14.rs.body --schema typescript
tools har-analyzer expand e14.rs.body
```

### Debug API Errors

```bash
tools har-analyzer load capture.har
tools har-analyzer errors
tools har-analyzer show e14 --raw
```

### Analyze a Specific API

```bash
tools har-analyzer domain api.example.com
tools har-analyzer domain api.example.com --status 4xx
```

### Find Sensitive Data

```bash
tools har-analyzer security
```

### Compare Requests

```bash
tools har-analyzer diff e5 e14
```

## MCP Server

If configured as an MCP server (`tools har-analyzer mcp`), use:

- `har_load`
- `har_overview`
- `har_list`
- `har_detail`
- `har_expand`
- `har_search`
- `har_analyze`
- `har_flow`
- `har_diff`
- `har_export`
