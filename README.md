# Bing Daily Wallpaper（必应每日壁纸）

[![npm](https://img.shields.io/npm/v/dsh-bing-wallpaper)](https://www.npmjs.com/package/dsh-bing-wallpaper)

DeepSeek Harness（DSH）壁纸插件：把必应每日壁纸用作界面背景，每天自动更换，像必应首页一样；还能在最近 30 天里任选一天固定使用。

## 功能

- **每日壁纸**：必应当日壁纸铺满整个界面背景（2px 轻模糊保证文字可读），浅色/深色主题自动适配半透明磨砂表面
- **每天自动更换**：页面加载、跨午夜、标签页切回（日期已变）多条触发路径；Host 缓存感知日期，常开页面跨午夜后几分钟内自动换新
- **最近 30 天任选**：信息条上的九宫格按钮打开选择面板，点任意一天固定该壁纸；点「每日自动更换」恢复每天自动换
- **断网可用**：服务端缓存回退 + 页面端按天 localStorage 缓存
- **不遮挡对话**：信息条（标题·日期·选择·刷新）挂在输入框下方专属布局插槽的最左侧

> 入口提示：壁纸标题、日期、选图、刷新按钮位于**对话输入框正下方信息行的最左侧**（低调设计，悬停可见操作）。

## 安装

在 DSH 插件市场（dshmarket）搜索「必应壁纸 / bing wallpaper」，或在终端执行：

```sh
dsh plugin --profile <你的profile> add dsh-bing-wallpaper
```

安装后刷新页面即可生效。壁纸数据来自公开站点 [bing.fullpx.com](https://bing.fullpx.com/)，
上游不可达时自动回退最近一次成功结果。

## 配置（可选：4K）

默认使用 1080P（fhd）图。如需 4K，在你自己的 profile patch 层为该行覆盖 config：

```yaml
- id: bing-wallpaper
  name: 'dsh-bing-wallpaper'
  config:
    quality: uhd
```

修改后停用→启用该行（或重启）生效。

## 卸载

插件管理中移除 `dsh-bing-wallpaper` bundle 即可，不残留任何状态
（页面端仅留两份 localStorage 键：今日缓存与固定选择）。

## 实现说明

- Host 半在本地服务注册同源路由 `/plugins/bing-wallpaper/today` 与 `/plugins/bing-wallpaper/list`
  代理上游，页面端不做跨域请求；上游签名归档接口拒绝第三方签名，列表数据来自首页 HTML 解析 +
  Host 滚动归档（月初条目会少于 30 条，随时间自动补齐）
- Client 半通过官方 `theme.overrideTokens` 叠加半透明表面（叠加层数多，单层 alpha 压得很低），
  信息条挂 `conversation.composer.dock` 插槽，选择面板挂 `shell.overlay`
- 透明度定稿值见 `client.js` 的 `TOKEN_OVERRIDES`，可自行按比例调整

## 许可

MIT
