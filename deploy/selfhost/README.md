# SkillHub 自部署

从完整仓库运行安装向导：

```sh
bash deploy/selfhost/install.sh
```

需要 Docker、Compose 与 OpenSSL。APP 同机测试选 local；公网服务器选 public；已有 HTTPS 网关选 proxy。配置与数据保留在部署目录及 Docker 卷中，不要提交生成的环境文件或备份。

- [部署总览](../../docs/guide/self-host/one-command-install.md)
- [本机部署](../../docs/guide/self-host/local-deployment.md)
- [备份、恢复与升级](../../docs/guide/self-host/backup-restore-upgrade.md)
- [已有网关](../../docs/guide/self-host/existing-gateway.md)

手动构建必须使用仓库根上下文：

```sh
docker build -f server/Dockerfile .
```

Dockerfile.dockerignore 仅纳入公开构建输入。构建元数据由 scripts/public-server-inputs.json 定义；不依赖其他仓库。
备份的数据目录与加密恢复文件必须配套、分开保管；外部对象存储还须配置自身备份。先验证恢复，再用于重要数据。
