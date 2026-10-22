#!/bin/sh
set -eu
# Do not copy Prisma diagnostics into logs: they may contain connection details.
if ! node node_modules/prisma/build/index.js migrate deploy >/dev/null 2>&1; then
  echo 'SkillHub: prisma migrate deploy failed; Server was not started. Check database availability and migration state before retrying.' >&2
  exit 1
fi
exec node dist/index.js
