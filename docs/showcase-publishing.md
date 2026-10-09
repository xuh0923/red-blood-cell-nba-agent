# 提交作品展示页

提交给评委的根链接必须直接展示已完成作品，不能要求评委选择视频、上传文件或等待推理。CourtVision 根路径会读取 `showcase/manifest.json`，该清单指向三个预生成产物：

- `featured.mp4`：待展示的比赛片段或渲染成片
- `tracking.json`：连续视觉检测和身份确认结果
- `analysis.json`：该视频对应的深度数据分析、叠加事件和解说稿

这些文件会通过 Vite 构建进入 Web 静态产物，随后由 CloudFront 分发。根页面只读文件，不调用创建任务接口，也不会触发 Bedrock、视觉模型或 Step Functions。上传和分析功能位于“新建分析”入口，以及 `/?workspace=1`。

## 准备流程

在本地选定一个已经完成的任务，并准备与该视频严格对应的 `analysis.json` 后运行：

```powershell
npm run showcase:prepare -- --job <本地任务ID> --analysis <analysis.json路径> --title "最终作品标题" --team-id Team28
npm run build
```

该脚本只会重建 `apps/web/public/showcase/`，复制视频、轨迹和分析结果，并写入清单。该目录被 Git 忽略，避免将大体积比赛视频提交到源码仓库；它必须在正式 `npm run build` 和 CDK 部署前生成。

`docs/examples/showcase-analysis.example.json` 仅用于本地连通性验证，明确标为示例指标，不能作为最终参赛结论。正式发布必须使用赛事深度数据和 AgentCore 的真实分析结果。

## 提交前检查

1. 打开根路径，不附加 `?workspace=1`。
2. 确认首屏显示 `Team28`、完成作品视频、轨迹和数据洞察，且没有文件选择框。
3. 在无 AWS 凭证、无本地视觉服务的浏览器中刷新，确认仍能播放并查看结果。
4. 使用 CloudFront 根 URL 作为提交链接；不要把工作台 URL 或本机 `localhost` 地址交给评委。
