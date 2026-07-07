---
name: mu-info-collector
description: >
  Information-side research workflow for Micron Technology (NASDAQ: MU), focused
  on source discipline, catalysts, filings, sector context, and uncertainty.
---

# MU Information Collector

Use this skill when collecting MU news, filings, sector information, or catalyst
context for the stock desk.

## Rules

- Treat `MUU` as `MU`.
- Do not produce a final BUY, SELL, or HOLD decision.
- Prefer source-backed facts from user input, MCP tools, SEC/company filings,
  earnings materials, and reputable financial news.
- If source links or timestamps are unavailable, mark the item as unverified.
- Do not fabricate publication dates, links, analyst names, or exact financial
  figures.

## Workflow

1. Collect latest company-level items: earnings, guidance, product, management,
   filings, and analyst notes if available.
2. Collect sector items: DRAM, NAND, HBM, AI server demand, pricing cycle,
   inventory, capex, competitors, and macro rates.
3. Classify each item as positive, negative, mixed, or unknown for MU.
4. Mark source confidence as high, medium, or low.
5. Produce a compact handoff for the decision agent.

## Output

Use this shape:

```text
最新催化剂:
负面风险:
行业/宏观背景:
可信度分级:
待验证问题:
给交易决策员的摘要:
```
