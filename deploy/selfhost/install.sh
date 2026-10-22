#!/usr/bin/env bash
# Functions stay sourceable so tests need neither Docker nor public DNS.

fail() { printf 'SkillHub: %s\n' "$*" >&2; return 1; }

valid_domain() {
  local domain=$1 label
  [[ ${#domain} -le 253 && $domain == *.* && $domain != *[!a-zA-Z0-9.-]* ]] || return 1
  [[ $domain != .* && $domain != *. && $domain != *..* && ! $domain =~ ^[0-9.]+$ ]] || return 1
  [[ ${domain##*.} == [a-zA-Z]* ]] || return 1
  local IFS=.
  for label in $domain; do
    [[ ${#label} -le 63 && $label != -* && $label != *- ]] || return 1
  done
}

valid_email() {
  [[ $1 =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]
}

valid_ip() {
  local ip=$1 part count=0
  if [[ $ip != *:* ]]; then
    [[ $ip != *[!0-9.]* && $ip != .* && $ip != *. && $ip != *..* ]] || return 1
    local IFS=.
    for part in $ip; do
      [[ ${#part} -le 3 && ( $part == 0 || $part != 0* ) ]] || return 1
      (( 10#$part <= 255 )) || return 1
      count=$((count + 1))
    done
    [[ $count == 4 ]]
  else
    awk -v ip="$ip" 'BEGIN {
      if (ip ~ /[^0-9a-fA-F:]/ || ip ~ /:::/) exit 1
      n=split(ip, halves, "::"); if (n>2) exit 1
      count=0
      for (h=1; h<=n; h++) {
        if (halves[h] == "") continue
        k=split(halves[h], parts, ":"); count+=k
        for (i=1; i<=k; i++) if (length(parts[i])<1 || length(parts[i])>4) exit 1
      }
      exit !((n==1 && count==8) || (n==2 && count<8))
    }'
  fi
}

select_preset() {
  PRESET=$1
  DOMAIN=${2:-}
  ACME_EMAIL=${3:-}
  case "$PRESET" in
    local) PUBLIC_BASE_URL=http://127.0.0.1:3001; DOMAIN=; ACME_EMAIL= ;;
    public)
      valid_domain "$DOMAIN" || { fail 'Enter a DNS hostname, without a scheme, path or port.'; return 1; }
      valid_email "$ACME_EMAIL" || { fail 'ACME email is invalid.'; return 1; }
      PUBLIC_BASE_URL="https://$DOMAIN"
      ;;
    proxy)
      PUBLIC_BASE_URL=$DOMAIN; DOMAIN=; ACME_EMAIL=
      # A conservative URL alphabet also prevents dotenv/shell interpolation.
      local url_pattern='^https://([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(:[0-9]{1,5})?(/[a-zA-Z0-9._~/%:@+-]*)?$'
      [[ $PUBLIC_BASE_URL =~ $url_pattern ]] || { fail 'Proxy URL must be HTTPS, without credentials, query, fragment or whitespace.'; return 1; }
      local authority=${PUBLIC_BASE_URL#https://} port hostname
      authority=${authority%%/*}
      if [[ $authority == \[* ]]; then
        hostname=${authority#\[}; hostname=${hostname%%\]*}
        [[ $hostname == *:* ]] && valid_ip "$hostname" || { fail 'Proxy IPv6 address is invalid.'; return 1; }
      else
        hostname=${authority%%:*}
        if [[ $hostname =~ ^[0-9.]+$ ]]; then
          valid_ip "$hostname" || { fail 'Proxy IPv4 address is invalid.'; return 1; }
        else
          [[ $hostname == localhost ]] || valid_domain "$hostname" || { fail 'Proxy hostname is invalid; use a full DNS name.'; return 1; }
        fi
      fi
      if [[ $authority =~ :([0-9]+)$ ]]; then
        port=${BASH_REMATCH[1]}
        (( 10#$port >= 1 && 10#$port <= 65535 )) || { fail 'Proxy port must be 1–65535.'; return 1; }
      fi
      while [[ $PUBLIC_BASE_URL == */ ]]; do PUBLIC_BASE_URL=${PUBLIC_BASE_URL%/}; done
      ;;
    *) fail 'Choose local, public or proxy.'; return 1 ;;
  esac
}

env_value() { sed -n "s/^$2=//p" "$1"; }

write_env() (
  set -eu
  set +x
  umask 077
  local destination=$1 overwrite=${2:-false} jwt kek password temporary
  if [[ -e $destination || -L $destination ]]; then
    [[ $overwrite == true ]] || { fail '.env already exists; use --overwrite-env explicitly to reconfigure it.'; exit 1; }
    [[ -f $destination && ! -L $destination ]] || { fail 'Refusing to replace a non-regular .env.'; exit 1; }
    # Reconfiguration must not rotate the database password or encryption root.
    jwt=$(env_value "$destination" JWT_SECRET)
    kek=$(env_value "$destination" CREDENTIAL_KEK_BASE64)
    password=$(env_value "$destination" POSTGRES_PASSWORD)
    [[ $jwt =~ ^[a-f0-9]{64}$ && $password =~ ^[a-f0-9]{64}$ && $kek =~ ^[A-Za-z0-9+/]{43}=$ ]] || {
      fail 'Existing .env is not wizard-generated; preserve its keys and edit it manually.'; exit 1;
    }
  else
    jwt=$(openssl rand -hex 32)
    kek=$(openssl rand -base64 32)
    password=$(openssl rand -hex 32)
  fi
  temporary=$(mktemp "${destination}.tmp.XXXXXX")
  trap 'rm -f "$temporary"' EXIT
  chmod 600 "$temporary"
  cat >"$temporary" <<EOF
COMPOSE_PROJECT_NAME=skillhub-selfhost
COMPOSE_FILE=compose.yaml:compose.$PRESET.yaml
PRESET=$PRESET
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
POSTGRES_PASSWORD=$password
DATABASE_URL=postgresql://skillhub:$password@postgres:5432/skillhub
JWT_SECRET=$jwt
CREDENTIAL_KEK_BASE64=$kek
NODE_ENV=production
HOST=0.0.0.0
PORT=3001
SKILLHUB_PROFILE=selfhost
MEDIA_STORAGE_DIR=/var/lib/skillhub/media
SKILL_CARD_STORAGE_DIR=/var/lib/skillhub/cards
EOF
  if [[ $overwrite == true ]]; then
    mv -f "$temporary" "$destination"
  else
    # Exclusive creation also protects against a competing installer/symlink.
    ln "$temporary" "$destination" 2>/dev/null || { fail '.env already exists; left it untouched.'; exit 1; }
  fi
)

require_command() { command -v "$1" >/dev/null 2>&1 || fail "Missing $1. $2"; }

check_prerequisites() {
  require_command docker 'Install Docker Desktop/OrbStack (macOS) or Docker Engine (Linux).' || return 1
  docker compose version >/dev/null 2>&1 || { fail 'Install the Docker Compose v2 plugin.'; return 1; }
  local help endpoint
  help=$(docker compose up --help) || return 1
  [[ $help == *--wait-timeout* ]] || { fail 'Update Docker Compose v2: up --wait-timeout is required.'; return 1; }
  docker info >/dev/null 2>&1 || { fail 'Docker daemon is unavailable; start it and grant your user access (do not run this wizard with sudo).'; return 1; }
  if [[ -n ${DOCKER_CONTEXT:-} ]]; then
    endpoint=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}') || return 1
  else
    endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
  fi
  [[ $endpoint == unix://* ]] || { fail 'Run this wizard on the deployment host with a local Docker socket, not a remote Docker context.'; return 1; }
  require_command openssl 'Install OpenSSL for random secret generation.' || return 1
}

dns_records() {
  # Keep status information: SERVFAIL/timeout must not look like an absent AAAA.
  local answer
  answer=$(dig +time=5 +tries=1 +noall +comments +answer "$1" "$2") || { fail "DNS $2 lookup failed."; return 1; }
  [[ $answer == *'status: NOERROR,'* ]] || { fail "DNS $2 lookup did not return NOERROR."; return 1; }
  printf '%s\n' "$answer" | awk -v type="$2" '$4 == type {print $5}'
}

public_ip() {
  # Bypass ambient HTTP proxies: their exit address does not identify this host.
  curl --noproxy '*' "-$1" -fsS --connect-timeout 5 --max-time 10 https://api64.ipify.org 2>/dev/null
}

canonical_ip() {
  # Expand IPv6 so equivalent compressed/zero-padded DNS and egress IPs compare.
  awk -v ip="$1" 'BEGIN {
    ip=tolower(ip)
    if (index(ip, ":") == 0) {print ip; exit}
    n=split(ip, halves, "::")
    l=halves[1] == "" ? 0 : split(halves[1], left, ":")
    r=n == 1 || halves[2] == "" ? 0 : split(halves[2], right, ":")
    out=""
    for (i=1; i<=l; i++) {sub(/^0+/, "", left[i]); out=out ":" (left[i] == "" ? "0" : left[i])}
    if (n == 2) for (i=0; i<8-l-r; i++) out=out ":0"
    for (i=1; i<=r; i++) {sub(/^0+/, "", right[i]); out=out ":" (right[i] == "" ? "0" : right[i])}
    print out
  }'
}

check_dns_addresses() {
  local records4=$1 records6=$2 own4=$3 own6=$4 address
  [[ -n $records4 || -n $records6 ]] || { fail 'Domain has no A or AAAA records.'; return 1; }
  for address in $records4; do
    [[ -n $own4 && $address == "$own4" ]] || { fail 'A record does not match this server’s public IPv4. Fix DNS or use proxy for a gateway/CDN.'; return 1; }
  done
  for address in $records6; do
    [[ -n $own6 && $(canonical_ip "$address") == "$(canonical_ip "$own6")" ]] || {
      fail 'AAAA record is wrong/stale, or this server has no working public IPv6. Correct/remove AAAA before requesting a certificate.'; return 1;
    }
  done
}

check_free_ports() {
  local listeners sockets
  if command -v ss >/dev/null 2>&1; then
    listeners=$(ss -H -ltn '( sport = :80 or sport = :443 )') || { fail 'Cannot inspect TCP listeners.'; return 1; }
  else
    require_command netstat 'Install iproute2/ss or net-tools on Linux; macOS includes netstat.' || return 1
    # Socket tables include listeners owned by other users; unprivileged lsof may not.
    if [[ $(uname -s) == Darwin ]]; then
      sockets=$(netstat -an -p tcp) || { fail 'Cannot inspect TCP listeners.'; return 1; }
    else
      sockets=$(netstat -lnt) || { fail 'Cannot inspect TCP listeners.'; return 1; }
    fi
    listeners=$(printf '%s\n' "$sockets" | awk '$1 ~ /^tcp/ && $NF == "LISTEN" && $4 ~ /[.:](80|443)$/')
  fi
  [[ -z $listeners ]] || { fail 'TCP port 80 or 443 is occupied (or listener inspection failed). Stop the conflicting service before retrying.'; return 1; }
}

public_preflight() {
  valid_email "$ACME_EMAIL" || { fail 'ACME email is invalid.'; return 1; }
  require_command dig 'Install dnsutils (Debian/Ubuntu) or bind-utils (RHEL); macOS includes dig.' || return 1
  require_command curl 'Install curl for public IP and HTTPS checks.' || return 1
  local records4 records6 own4='' own6=''
  records4=$(dns_records "$DOMAIN" A) || return 1
  records6=$(dns_records "$DOMAIN" AAAA) || return 1
  if [[ -n $records4 ]]; then own4=$(public_ip 4) || { fail 'Cannot determine this server’s public IPv4.'; return 1; }; fi
  if [[ -n $records6 ]]; then own6=$(public_ip 6) || own6=''; fi
  check_dns_addresses "$records4" "$records6" "$own4" "$own6" || return 1
  check_free_ports
}

compose() (
  # Exported shell variables take precedence over --env-file; use saved values.
  unset POSTGRES_PASSWORD JWT_SECRET CREDENTIAL_KEK_BASE64 PUBLIC_BASE_URL DOMAIN ACME_EMAIL
  docker compose --project-name skillhub-selfhost --env-file "$INSTALL_DIR/.env" \
    -f "$INSTALL_DIR/compose.yaml" -f "$INSTALL_DIR/compose.$PRESET.yaml" "$@"
)

extract_setup_code() {
  sed -nE 's/^SkillHub 自部署初始化码：([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})$/\1/p' | tail -n 1
}

show_setup() {
  local state code attempt container started
  container=$(compose ps -q server) || return 1
  started=$(docker inspect --format '{{.State.StartedAt}}' "$container") || return 1
  for ((attempt=0; attempt<30; attempt++)); do
    state=$(compose exec -T server node -e "fetch('http://127.0.0.1:3001/api/setup/status', {headers: {Host: new URL(process.env.PUBLIC_BASE_URL).host}, signal: AbortSignal.timeout(4000)}).then(async r => {if (!r.ok) process.exit(1); console.log((await r.json()).initialized ? 'initialized' : 'pending')}).catch(() => process.exit(1))") || return 1
    if [[ $state == initialized ]]; then printf 'Instance already initialized; use your existing administrator account.\n'; return 0; fi
    code=$(compose logs --since "$started" --no-color --no-log-prefix --tail 200 server | extract_setup_code) || return 1
    if [[ -n $code ]]; then
      printf 'One-time setup code: %s\nExpires 30 minutes after Server startup; keep it private.\n' "$code"
      return 0
    fi
    sleep 1
  done
  fail 'Server is healthy but no setup code appeared. Check database/setup state; do not repeatedly restart Caddy.'
}

main() {
  set -euo pipefail
  set +x
  local overwrite=false preset domain='' email='' attempt healthy=false
  case "${1:-}" in
    '') ;;
    --overwrite-env) overwrite=true ;;
    *) fail 'Usage: bash deploy/selfhost/install.sh [--overwrite-env]'; return 1 ;;
  esac
  [[ $# -le 1 ]] || { fail 'Too many arguments.'; return 1; }
  INSTALL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  read -r -p 'Where to deploy? local / public / proxy: ' preset
  case "$preset" in
    public)
      read -r -p 'Domain (e.g. skills.example.com): ' domain
      read -r -p 'ACME email: ' email ;;
    proxy) read -r -p 'External HTTPS URL: ' domain ;;
  esac
  select_preset "$preset" "$domain" "$email"
  if [[ -e $INSTALL_DIR/.env || -L $INSTALL_DIR/.env ]]; then
    [[ $overwrite == true ]] || { fail '.env already exists; use --overwrite-env explicitly to reconfigure, or docker compose up -d to resume.'; return 1; }
  fi
  check_prerequisites
  if [[ $PRESET == public ]]; then
    printf 'Open inbound TCP 80/443 in your firewall/security group. Local checks cannot prove Internet reachability.\n'
    printf 'If ports 80/443 cannot be opened, consider DNS-01 (custom Caddy DNS plugin). Mainland China hosting may require ICP filing. https://sk.woe.show/docs/self-host/\n'
    public_preflight
  fi
  write_env "$INSTALL_DIR/.env" "$overwrite"
  # --wait checks /health; service restart policies still apply on failure.
  if ! compose up -d --build --wait --wait-timeout 180 --remove-orphans; then
    if [[ $PRESET == public ]]; then compose stop caddy; fi
    fail 'Stack startup failed. Inspect with docker compose logs server; stop a migration restart loop with docker compose stop server (from deploy/selfhost).'
    return 1
  fi
  if [[ $PRESET == public ]]; then
    for ((attempt=0; attempt<30; attempt++)); do
      if curl --noproxy '*' -fsS --connect-timeout 3 --max-time 5 "$PUBLIC_BASE_URL/health" >/dev/null 2>&1; then healthy=true; break; fi
      sleep 2
    done
    if [[ $healthy != true ]]; then
      compose stop caddy
      fail 'Public HTTPS /health did not become reachable; Caddy stopped. Fix DNS/firewall/certificate problems before an explicit retry.'
      return 1
    fi
  fi
  printf 'Server /health is ready. App server address: %s\n' "$PUBLIC_BASE_URL"
  show_setup
  if [[ $PRESET == proxy ]]; then printf 'Configure your gateway using nginx.conf.example or tailscale-serve.example.sh, then test the external HTTPS address in the app.\n'; fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
