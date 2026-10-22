# APP 控制

SkillHub Manager 只控制已经安装的 SkillHub APP，不处理下载安装。当前公开命令是：

```sh
skillhub app open --json
```

1. 使用它打开或聚焦 APP。
2. 只接受该固定动作；不要把用户文本当作 URL、文件路径、Shell 参数或深链。
3. 命令不可用或失败时，请用户手动打开 APP；不要猜应用名称、bundle id、可执行路径或注册表位置。

需要登录、确认安装更新、填写凭据、处理图片反馈或修复 CLI 时，可以把用户引导到 APP，但不能声称已自动完成未返回成功的导航。
