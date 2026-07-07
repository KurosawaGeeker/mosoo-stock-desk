# Mosoo Stock Desk

Mosoo-hosted multi-agent stock desk for Micron Technology (`MU`). The app uses
three Mosoo Agents:

- `MU 盯盘员`: market watch and key levels.
- `信息面收集员`: news, filings, sector and catalyst collection.
- `交易决策员`: final buy/sell/hold research memo and email draft.

The Worker frontend talks only to its own backend. The backend calls Mosoo
Agents through env bindings injected by Mosoo deploy:

- `MOSOO_AGENT_MU_WATCH_URL`
- `MOSOO_AGENT_INFO_URL`
- `MOSOO_AGENT_DECISION_URL`

Optional email env:

- `RESEND_API_KEY`
- `MAIL_FROM`
- `MAIL_TO`

If email env is absent, the UI still keeps the decision memo and shows that
automatic delivery is not configured.

This app is for research workflow automation only. It does not execute orders
and does not provide financial advice.
