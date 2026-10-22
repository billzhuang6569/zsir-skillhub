# 一探 SkillHub

SkillHub 是面向 macOS 与 Windows 的 Agent Skills 管理工具：把 Skill 放到统一托管位置，查看版本、安装到多个 Agent，并通过账号同步与团队共享协作。

三种使用方式：一探官方直接使用账号服务；仅本机管理当前电脑的 Skills；自部署由你管理服务器、账号与存储。详见 [使用文档](docs/guide/index.md)。

## 5 分钟本机部署

APP 与 Server 须在同一台电脑，Mac 可用 Docker Desktop、OrbStack 或 colima；Linux 服务器请选 public 或 proxy，Windows 原生安装未提供、WSL2 Docker 未验证。准备已启动的 Docker、支持 `up --wait-timeout` 的 Compose v2 或更高主版本与 OpenSSL。公开仓库地址尚待确定，替换 `OWNER` 和实际 `<发布 tag>` 后取得整个仓库，不能只拷贝部署目录：

```sh
git clone https://github.com/billzhuang6569/zsir-skillhub
cd zsir-skillhub
git checkout <发布 tag>
bash deploy/selfhost/install.sh
```

在英文提示中输入 `local` 回车。首次安装预计 1.5–5 分钟，取决于网络与主机性能。等待向导给出 APP 地址与初始化码，在同机 APP 设置中连接并创建管理员；“5 分钟”不保证完成时间。

完整步骤见 [在自己电脑上部署](docs/guide/self-host/local-deployment.md)，重要数据使用前先设置 [备份与恢复](docs/guide/self-host/backup-restore-upgrade.md)。

## 许可证与贡献

[许可证](LICENSE) · [贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [商标政策](TRADEMARK.md)。
