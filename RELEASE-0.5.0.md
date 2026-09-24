# 用量喵 0.5.0

本次仅构建安装包，未自动安装、卸载或替换桌面快捷方式。

## 更新内容

- 价格目录：按厂商、渠道和模型搜索；展示输入、输出和缓存读取单价（USD / 百万 Token）。支持 OpenAI、Anthropic、Gemini、DeepSeek、通义千问、Z.ai、Kimi、MiniMax 等公开文本模型价格。
- 保留启动后台检查、每小时检查、发现缺价时限频检查和手动同步；断网使用本地缓存。公开源未提供的模型或价格仍提示缺失，不当作免费。
- Agent 接入：18 种接入类型的目录状态、今日 / 30 天 Token、估算成本及缺价模型。可选择日志目录、恢复自动发现；不会修改 Agent 的登录或 API 配置。
- 概览新增按 Agent 汇总，未定价 Agent 也能显示 Token。
- 参考价匹配：支持指定 Agent 的厂商，以及指定 Agent / 日志模型的价格条目。仅在指定厂商内精确匹配，避免猜测跨平台价格。
- 根据用户确认，ZCode 默认参考 Z.ai 国际版。修复 ccusage 全部 Agent 汇总忽略 Agent 单独价格设置的问题，重算后只替换目标 Agent，避免重复累计或影响其他 Agent。

## ZCode 原因与统计边界

原日志已读取到 116,118 Token，但原始模型名 GLM-5.3 没有匹配价格，所以成本为零。修复后的同一批日志参考估算为 $0.04328688。

ZCode 读取 ZCODE_HOME/cli/db/db.sqlite，默认用户目录下的 .zcode。仅统计完成的本机记录；缓存创建 Token 按 Z.ai 输入参考价处理。

金额是公开 API 参考估算，不是 Coding Plan 实际扣费、剩余额度或历史账单。当前价格用于重新估算最近 30 天记录；特殊上下文分档、折扣、图片 / 音频等非文本计费不保证完整覆盖。不同厂商的同名模型需选择对应渠道。

本次实机验证了 Codex、pi 和 ZCode；其余接入依赖内置 ccusage 支持的日志格式。目录存在不代表有用量，未发现默认目录也不代表没有安装。此版本不增加跨设备日志同步。

## 安装与测试

安装包：E:\用量喵\dist\用量喵-0.5.0-安装包.exe

建议关闭正在运行的旧版后，由用户自行安装。不要把项目源码根目录选作安装目录。可用独立测试目录验证安装和 unins.exe 卸载。安装程序未商业签名，Windows 可能提示未知发布者。

## 本地设置与隐私

用户数据目录新增 agent-sources-v1.json（日志目录选择）和 price-references-v1.json（参考价绑定）；价格快照和统计缓存延续原有文件。只读取用量数据，不新增凭证或对话正文采集，不向价格源上传日志。价格同步使用公开 GET 请求。

## 验证

41 项自动逻辑测试通过，覆盖多厂商匹配、目录持久化、缓存失效、跨 Agent 重算隔离及原有功能。五个页面共 25 组布局测试通过，并验证价格筛选与选择。卸载清单检查覆盖 74 个打包文件，无递归目录或通配符删除；未实际运行安装和卸载。

## 数据来源

- ccusage ZCode 说明：https://ccusage.com/guide/zcode/
- Z.ai 官方价格：https://docs.z.ai/guides/overview/pricing
- 多厂商公开价格表：https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
- OpenAI 官方价格：https://developers.openai.com/api/docs/pricing.md
