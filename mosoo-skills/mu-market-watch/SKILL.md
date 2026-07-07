---
name: mu-market-watch
description: >
  Structured market-watch workflow for Micron Technology (NASDAQ: MU), including
  delayed quote handling, level extraction, volume/volatility checks, and
  handoff notes for a decision agent.
---

# MU Market Watch

Use this skill whenever the user asks about MU, MUU, Micron, or the stock desk
asks for market-watch input.

## Rules

- Treat `MUU` as a user typo for `MU`.
- Do not execute trades or imply that a signal is personalized financial advice.
- Use the freshest quote, OHLC, volume, and timestamp provided by the user,
  app, or MCP tools. If data is delayed or missing, say so before drawing a
  conclusion.
- Never invent prices, volume, pre-market values, after-hours values, analyst
  targets, or news.
- Separate observed facts from interpretation.

## Workflow

1. Identify the trading context: intraday, swing, earnings, or event-driven.
2. Read the latest available quote and timestamp.
3. Extract support/resistance from high, low, close, open, and recent narrative.
4. Check volume and volatility relative to the information available.
5. State three concrete triggers that would change the market-watch view.
6. Hand off unresolved questions to the information or decision agent.

## Output

Use this shape:

```text
盘面状态:
关键价位:
成交量/波动:
触发条件:
风险提示:
交给其他 Agent 确认:
```
