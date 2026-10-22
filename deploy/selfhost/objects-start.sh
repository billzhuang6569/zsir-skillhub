#!/bin/sh
set -eu
umask 077
# Local example accepts generated hex/alphanumeric credentials so JSON needs no escaping.
for credential in "${S3_ACCESS_KEY_ID:-}" "${S3_SECRET_ACCESS_KEY:-}"; do
  case "$credential" in ''|*[!a-zA-Z0-9]*) echo 'Invalid local S3 credentials' >&2; exit 1;; esac
done
unset credential
[ "${#S3_ACCESS_KEY_ID}" -ge 16 ] && [ "${#S3_SECRET_ACCESS_KEY}" -ge 32 ] || exit 1
printf '{"identities":[{"name":"skillhub","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}\n' \
  "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/run/skillhub/s3.json
unset S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
exec weed server -dir=/data -ip=seaweedfs -ip.bind=0.0.0.0 -s3 -s3.port=8333 -s3.config=/run/skillhub/s3.json
