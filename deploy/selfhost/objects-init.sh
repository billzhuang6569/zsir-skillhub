#!/bin/sh
set -eu
case "${S3_BUCKET:-}" in ''|*[!a-z0-9.-]*|-*|.*|*-|*.) echo 'Invalid bucket name' >&2; exit 1;; esac
[ "${#S3_BUCKET}" -ge 3 ] && [ "${#S3_BUCKET}" -le 63 ] || exit 1
# weed shell reports an existing bucket as an error; accept only that exact error.
attempt=0
while [ "$attempt" -lt 30 ]; do
  result=$(printf 's3.bucket.create -name %s -owner skillhub\n' "$S3_BUCKET" |
    weed shell -master=seaweedfs:9333 -filer=seaweedfs:8888 2>&1) && exit 0
  case "$result" in *"bucket $S3_BUCKET already exists"*) exit 0;; esac
  attempt=$((attempt + 1))
  sleep 2
done
echo 'Local S3 bucket initialization failed' >&2
exit 1
