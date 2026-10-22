#!/usr/bin/env bash
# Run on the SAME HOST as Docker. Enable HTTPS in your tailnet first.
# Use https://<machine>.<tailnet>.ts.net as the wizard's proxy URL.
tailscale serve --bg --https=443 http://127.0.0.1:3001
# Inspect: tailscale serve status
# Stop this listener: tailscale serve --https=443 off
# Serve is tailnet-only, not public Funnel. Restrict access with tailnet grants.
# It terminates TLS locally; SkillHub still requires its own Bearer token.
# Do not map Tailscale identity/forwarding headers to SkillHub users or auth.
# The gateway must send X-Forwarded-For (client IP) and X-Forwarded-Proto (https).
# Check these headers with your Serve version; Server trusts the dedicated
# Compose subnet containing the Docker host gateway (see README.md).
