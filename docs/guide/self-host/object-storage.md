---
title: 可选 S3 与 OSS
description: 将媒体和卡片从默认文件系统复制到私有对象存储。
sidebar: { order: 10 }
---

默认使用文件系统，无须配置 S3。需要对象存储时，先创建私有 bucket，再在 Server 配置以下变量；密钥只留 Server，不给 APP。

| 变量 | 填写方式 |
| --- | --- |
| `S3_ENDPOINT` | 服务 endpoint，不含 bucket、路径、凭据、查询或片段 |
| `S3_REGION` | bucket 的地域 |
| `S3_BUCKET` | bucket 名称 |
| `S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` | 受限访问凭据 |
| `S3_PREFIX` | 可选相对前缀，不带首尾斜杠 |
| `S3_FORCE_PATH_STYLE` | 按服务要求选择，默认 false |
| `STORAGE_DEFAULT` | 先保持 filesystem，复制校验完成后改为 s3 |

endpoint 要求 HTTPS；回环或管理员配置的同一可信 Compose 网络单标签服务名可用 HTTP。单标签不等于网络隔离，不能用于不可信 DNS。图片仍经 SkillHub 校验与读取，不生成预签名 URL。

AWS S3 通常用 bucket 地域与虚拟主机寻址；OSS 用 S3 接口 endpoint 和对应地域，不能直接把已绑定 bucket 的 CNAME 当作通用 endpoint。R2 的 region 为 `auto`，常用 path-style；已有 MinIO 等 SigV4 服务也可配置。具体参数以自己供应商为准，本页不代表所有厂商均已实测。

## 权限

凭据需要 bucket 级 `s3:ListBucket`，以及对象级 `s3:GetObject`、`s3:PutObject`、`s3:DeleteObject`；对象权限可限制到所用前缀。缺 `s3:ListBucket` 时，不存在的对象可能返回 403 而非 404；SkillHub 只把 404 当缺失，403 会被当作服务不可用。

## 本地 SeaweedFS 示例

先完成普通安装。在 `deploy/selfhost/.env` 原 `COMPOSE_FILE` 值末尾追加 `:compose.s3-local.yaml`，不要替换原预设或原有密钥。添加：

```dotenv
STORAGE_DEFAULT=filesystem
S3_BUCKET=skillhub
S3_PREFIX=skillhub
S3_ACCESS_KEY_ID=<随机字母数字至少16字符>
S3_SECRET_ACCESS_KEY=<随机字母数字至少32字符>
```

分别用 `openssl rand -hex 16` 与 `openssl rand -hex 32` 在私人终端生成凭据，写入权限 `0600` 的 `.env`，不要提交。叠加文件提供 endpoint `http://seaweedfs:8333`、region `us-east-1` 和 path-style 设置，并创建 bucket。

这是单节点持久化示例，不发布对象服务的宿主端口。不要向该 Compose 网络加入不可信容器。本例字母数字限制用于配置生成，不是所有云服务凭据的通用限制。

## 复制校验后改指

在 `deploy/selfhost` 执行：

```sh
docker compose up -d --wait --wait-timeout 180
docker compose exec server npm run storage -- status
docker compose exec server npm run storage -- copy --to s3 --dry-run --repoint
docker compose exec server npm run storage -- copy --to s3 --repoint
```

`--dry-run` 不读写对象、不改数据库。实际复制逐对象读回比较 SHA-256 和大小，通过后只改仍指向原对象的记录；冲突记入 `failed`，可修正后重跑。不加 `--repoint` 仅复制。

要完成一次无遗漏切换，暂停 Server 写入并收尾，保留数据库和对象服务：

```sh
docker compose stop server
docker compose run --rm --no-deps --entrypoint node server dist/ops/storage.js copy --to s3 --repoint
```

确认 `failed` 为空后，在 `.env` 改为 `STORAGE_DEFAULT=s3`，再执行：

```sh
docker compose up -d --force-recreate server
docker compose exec server npm run storage -- status
```

保留 `MEDIA_STORAGE_DIR`、`SKILL_CARD_STORAGE_DIR` 和旧卷，旧行按各自归属读取。当前没有删除源对象的命令，观察并备份后再决定是否清理。

## 更换服务与备份

endpoint、bucket、prefix 决定 namespace；改密钥和 path-style 不改变 namespace。旧 S3 引用仍存在时不能直接覆盖这三项。换服务先 `copy --to filesystem --repoint`，确认全部引用转回本地，再换配置并复制到新 S3。

本地叠加的对象卷包含在实例备份中；外部 S3 必须自行启用版本控制、复制或独立备份。未知 namespace 返回 503，也会阻止恢复成功，见 [S3 排查](troubleshooting.md#s3-namespace-unavailable)。
