# 用量喵

用量喵是 Windows 桌面应用，启动后读取本机 AI 编码助手日志，展示最近 30 天的 Token 和成本估算。支持按 Agent、模型查看用量，并提供可搜索的公开 API 价格目录。

当前版本：**0.6.0**。从 [GitHub Releases](../../releases/latest) 下载：

- `usage-meow-0.6.0-setup.exe`：安装版，带卸载程序。
- `usage-meow-0.6.0-portable.exe`：单文件便携版，每次启动需要解压，启动速度可能慢于安装版。

安装包和便携版均未进行商业代码签名。建议安装到独立目录，不要选择源码目录。卸载默认保留应用数据与原始 Agent 日志。

## 功能

- 打开后读取本机日志，显示今日、最近 30 天和每日趋势；每 5 分钟自动刷新。
- 概览页“今天消耗明细”按 Agent 和模型展示输入、输出、缓存读写 Token，以及对应的公开 API 参考单价（USD / 百万 Token）和该模型当天估算成本。可切换最近 30 天有记录的日期，也可点击“用量记录”的日期跳转。
- Agent 接入页显示 18 种支持类型的目录状态、Token、估算成本和缺价模型，可选择自定义日志目录。
- 模型明细页按 Agent 筛选；价格目录页按厂商、模型搜索并手动绑定参考价。
- 价格表在启动后后台检查、每小时检查，发现缺价时限频重试；断网使用本地缓存。
- ZCode 的 GLM-5.3 默认按用户确认的 Z.ai 国际版公开 API 价格参考估算。
- Codex 账号中心读取已接入本机配置的登录来源和官方用量信息。

成本为公开 API 价格估算，不代表 Coding Plan 或其他订阅的实际扣费、余额。日志中未提供可靠账号归属的历史用量不会反推到某个账号。目录可识别不代表已有记录。跨设备用量仅限提供方官方接口可返回的账号汇总，不同步其他设备日志。

完整更新说明见 [RELEASE-0.6.0.md](RELEASE-0.6.0.md)。

## 本地开发

需要 Windows 与 Node.js 22+：

```powershell
npm ci
npm test
npm start
npm run build
npm run build:portable
```

`npm run build` 生成 NSIS 安装包，`npm run build:portable` 生成便携版。构建脚本只将程序文件打入安装包；卸载清单按当次打包文件生成。应用数据通常保存在 `%APPDATA%\用量喵`，其中可能包含本机路径和聚合用量，不应提交到仓库。

本项目使用 Electron、electron-builder 与 [ccusage](https://github.com/ryoppippi/ccusage)。
