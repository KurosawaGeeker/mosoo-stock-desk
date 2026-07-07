---
name: mu-risk-decision
description: >
  Research-only decision workflow for Micron Technology (NASDAQ: MU), combining
  market and information inputs into a controlled BUY/SELL/HOLD memo.
---

# MU Risk Decision

Use this skill when producing the final research memo for MU.

## Rules

- This workflow is research-only. Do not execute trades.
- If market or information inputs are stale, contradictory, or missing, prefer
  `HOLD` or a reduced-confidence signal.
- Every non-HOLD signal must include an invalidation condition and downside
  risk.
- Do not invent quote, news, or portfolio facts.
- Keep the email body ready to send to `363876315@qq.com`.

## Workflow

1. Read the market-watch handoff and information handoff.
2. Read user risk parameters: shares, cost basis, horizon, max loss, and
   constraints.
3. Decide whether evidence supports BUY, SELL, or HOLD.
4. State confidence and the reason confidence is not higher.
5. Convert the decision into an email body with concrete next steps.

## Output

Use this shape:

```text
信号: BUY / SELL / HOLD
置信度: 低 / 中 / 高
建议动作:
仓位和风控:
核心理由:
反方观点:
失效条件:
下一步任务:
邮件正文:
```
