# DeepSeek Harness

`house` 是 DeepSeek Harness 的 Electron 桌面壳。应用启动后会在本机托管 Harness Web profile，并在服务就绪后直接显示官方 Web GUI；Harness 的会话、设置、工作区和工具能力仍由 `deepseek-harness` 源码提供。

本目录是独立 Git 仓库；`deepseek-harness` 是相邻的 DeepSeek 官方源码仓库，不属于本仓库的提交范围。

## 版本说明

- 桌面壳版本由 `package.json` 的 `version` 字段定义，当前为 `1.1.0`。
- 引用的 Harness 版本在每次 `npm run build` 或 `npm run stage:harness` 时自动读取相邻源码仓库的 `package.json` 和 Git 提交，写入 `app/build-info.json`。
- 启动页会显示壳版本、Harness 包版本和 Git 短提交；如果源码仓库存在未提交改动，还会标记“含本地源码改动”。
- 当前构建基线：Harness `0.1.0-rc.5`，Git 提交 `47f943859bef60e4160492346772ded9b24f765a`（`47f9438`）。

这使安装包可以追溯到明确的 Harness 源码版本，即使目标电脑没有安装或保留 `deepseek-harness` 源码目录。

## 开发运行

要求 Node.js 22 或更高版本，并先构建 Harness 的 Node 和 Web 产物：

```powershell
cd ..\deepseek-harness
pnpm run build

cd ..\house
npm install
npm start
```

壳会自动查找相邻的 `deepseek-harness` 目录。也可以通过环境变量指定源码目录：

```powershell
$env:DEEPSEEK_HARNESS_ROOT = "D:\src\deepseek-harness"
npm start
```

Harness 后端只绑定 `127.0.0.1`，并由壳在退出时关闭。启动失败时，窗口会保留重试入口；常见原因是 Harness 尚未执行 `pnpm run build`，或 workspace 依赖没有安装。

## 验证和打包

```powershell
npm test
npm run build
npm run dist
```

`npm run dist` 会依次构建桌面壳和 Harness、生成裁剪后的生产运行时，并把压缩归档放进安装包。应用首次启动时会把归档解到版本化的用户数据目录，后续启动直接复用。最终的 Windows 安装程序位于 `release/DeepSeek-Harness-Setup-<version>.exe`，目标电脑不需要另行安装 Node.js 或准备 Harness 源码。
