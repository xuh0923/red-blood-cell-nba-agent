# 本地展示产物

根路径读取 `apps/web/public/showcase` 中的静态文件，不依赖本地视觉服务、不触发新任务，也不访问远端接口。这样可以在没有账号、网络或模型服务的机器上打开作品展示页。

## 生成

先用本地工作台完成一条任务，然后运行：

```powershell
npm run showcase:prepare -- --job <本地任务UUID> --analysis <分析JSON路径>
```

脚本会复制视频、`tracking.json`、分析 JSON 和统计 JSON，并生成 `manifest.json`。原始视频、任务目录和模型权重仍由 `.gitignore` 排除，不提交到 Git。

## 检查

```powershell
npm run build
npm run dev:web
```

打开 `http://127.0.0.1:5173`，确认作品展示可以播放视频、同步跟踪、切换时间轴并查看证据。素材导入工作台使用 `http://127.0.0.1:5173/?workspace=1`。
