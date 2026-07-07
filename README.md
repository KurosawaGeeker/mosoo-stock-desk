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
- `MCP_BEARER_TOKEN`

If email env is absent, the UI still keeps the decision memo and shows that
automatic delivery is not configured.

## Mosoo Skills and MCP

The three Agents are enhanced with Mosoo Skills:

- `mu-market-watch` (`01KWXP3FZ5NEJH7B76RBMCBGPM`) for MU price action workflow.
- `mu-info-collector` (`01KWXP3FJ3D869DNM7AWVCSZ8R`) for MU news, filings and sector catalysts.
- `mu-risk-decision` (`01KWXP3FEXJYM0MMN08PAYCQQF`) for research-only buy/sell/hold decisions.

The app also exposes `/mcp` as an app MCP server:

- MCP server: `MU Stock Desk MCP` (`01KWXPEM61H3AGQJAWV0Z6488K`)
- URL: `https://app-01kwxk0qnvm0687gamyph0mxmz.apps.mosoo.ai/mcp`
- Tools: `get_mu_quote`, `get_mu_news`, `draft_mu_decision_email`

This app is for research workflow automation only. It does not execute orders
and does not provide financial advice.
