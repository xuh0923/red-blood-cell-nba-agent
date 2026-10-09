import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, BadgeCheck, BarChart3, Check, ChevronRight, CircleDot, Cloud, Cpu, Database,
  FileJson, Film, Gauge, HardDriveUpload, Images, Info, LayoutDashboard, Link2,
  LoaderCircle, Mic2, Play, Radio, RotateCcw, ShieldCheck, Sparkles, Upload, Users, Volume2, Wifi
} from "lucide-react";
import {
  metricDisplay,
  type Analysis,
  type JobStatus,
  type OverlayEvent,
  type TrackingResult,
  type TrackedPlayer
} from "@courtvision/contracts";
import { createDemoAnalysis, parseDataFile, workflowSteps } from "./demo-workflow";
import { cloudAvailable, runCloudWorkflow } from "./cloud-workflow";
import { extractVideoFrames, releaseFrames, type ExtractedFrame } from "./video-frames";
import { runLocalVisionWorkflow, updateLocalTrackIdentity } from "./local-workflow";
import { loadShowcase, type ShowcaseArtifact } from "./showcase";

type Tab = "overview" | "evidence" | "identity" | "device";
type AnalysisMode = "local" | "cloud";
type Screen = "showcase" | "workspace";

const statusLabels: Record<JobStatus, string> = {
  draft: "等待输入", uploading: "校验输入", queued: "等待处理", extracting_frames: "读取视频帧",
  analyzing: "连续视觉分析", rendering: "生成叠加", publishing: "准备结果", completed: "分析完成", failed: "处理失败"
};
const metricIcons = [Gauge, Activity, BarChart3];

function FilePicker({ kind, file, onChange }: { kind: "video" | "data" | "roster"; file?: File; onChange: (file?: File) => void }) {
  const isVideo = kind === "video";
  const isRoster = kind === "roster";
  const Icon = isVideo ? Film : isRoster ? Users : FileJson;
  return (
    <label className={`file-picker ${file ? "has-file" : ""}`}>
      <input
        type="file"
        aria-label={isVideo ? "比赛视频" : isRoster ? "比赛名单 JSON" : "深度数据 JSON 或 CSV"}
        accept={isVideo ? "video/mp4,video/quicktime" : isRoster ? ".json,application/json" : ".json,.csv,application/json,text/csv"}
        onChange={(event) => onChange(event.target.files?.[0])}
      />
      <span className="file-icon"><Icon size={22} /></span>
      <span className="file-copy">
        <strong>{file?.name ?? (isVideo ? "选择比赛视频" : isRoster ? "选择比赛名单" : "选择深度数据")}</strong>
        <small>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : (isVideo ? "MP4 / MOV，建议 30 秒以内" : isRoster ? "JSON，号码与球队身份约束" : "JSON / CSV，可暂用内置数据")}</small>
      </span>
      <span className="file-action">{file ? <Check size={18} /> : <Upload size={18} />}</span>
    </label>
  );
}

function Overlay({ event }: { event?: OverlayEvent }) {
  if (!event) return null;
  return (
    <div className={`video-overlay ${event.anchor} accent-${event.accent}`}>
      <div className="overlay-kicker"><CircleDot size={13} /> LIVE INSIGHT</div>
      <div className="overlay-title">{event.title}</div>
      <div className="overlay-metric">{metricDisplay(event.metric)} <span>{event.metric.label}</span></div>
      <p>{event.explanation}</p>
    </div>
  );
}

function TrackingLayer({ players, ball }: {
  players: TrackedPlayer[];
  ball?: TrackingResult["frames"][number]["ball"];
}) {
  return (
    <div className="tracking-layer" aria-label="连续球员跟踪">
      {players.map((player) => {
        const label = player.role === "referee-candidate" ? "裁判候选" : player.playerName ?? (player.jerseyNumber ? `#${player.jerseyNumber}` : player.label);
        return (
          <div
            className={`player-track ${player.team} ${player.role}`}
            key={player.trackId}
            style={{
              left: `${player.box.x * 100}%`,
              top: `${player.box.y * 100}%`,
              width: `${player.box.width * 100}%`,
              height: `${player.box.height * 100}%`
            }}
          >
            <span>{label}</span>
          </div>
        );
      })}
      {ball && (
        <span
          className="ball-track"
          style={{
            left: `${(ball.box.x + ball.box.width / 2) * 100}%`,
            top: `${(ball.box.y + ball.box.height / 2) * 100}%`
          }}
          title={`篮球置信度 ${Math.round(ball.confidence * 100)}%`}
        />
      )}
    </div>
  );
}

const trackingFrameAt = (tracking: TrackingResult | undefined, seconds: number) => {
  if (!tracking?.frames.length) return undefined;
  let low = 0;
  let high = tracking.frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (tracking.frames[middle]!.atSeconds <= seconds) low = middle;
    else high = middle - 1;
  }
  const frame = tracking.frames[low];
  const maxAge = Math.max(0.35, 1.6 / tracking.video.processedFps);
  return frame && Math.abs(seconds - frame.atSeconds) <= maxAge ? frame : undefined;
};

export function App() {
  const [screen, setScreen] = useState<Screen>(() => new URLSearchParams(window.location.search).get("workspace") === "1" ? "workspace" : "showcase");
  const [showcase, setShowcase] = useState<ShowcaseArtifact>();
  const [showcaseError, setShowcaseError] = useState<string>();
  const [videoFile, setVideoFile] = useState<File>();
  const [dataFile, setDataFile] = useState<File>();
  const [rosterFile, setRosterFile] = useState<File>();
  const [videoUrl, setVideoUrl] = useState<string>();
  const [status, setStatus] = useState<JobStatus>("draft");
  const [progress, setProgress] = useState(0);
  const [analysis, setAnalysis] = useState<Analysis>();
  const [activeEvent, setActiveEvent] = useState<OverlayEvent>();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [error, setError] = useState<string>();
  const [isRunning, setIsRunning] = useState(false);
  const [frames, setFrames] = useState<ExtractedFrame[]>([]);
  const [tracking, setTracking] = useState<TrackingResult>();
  const [localJobId, setLocalJobId] = useState<string>();
  const [identitySavingTrack, setIdentitySavingTrack] = useState<number>();
  const [trackingTime, setTrackingTime] = useState(0);
  const [mode, setMode] = useState<AnalysisMode>(cloudAvailable ? "cloud" : "local");
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackingFrameTimeRef = useRef(-1);

  useEffect(() => {
    if (!videoFile) {
      if (!showcase) setVideoUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile, showcase]);

  useEffect(() => {
    if (screen !== "showcase" || showcase) return;
    let cancelled = false;
    void loadShowcase().then((artifact) => {
      if (cancelled) return;
      setShowcase(artifact);
      setVideoUrl(artifact.videoUrl);
      setAnalysis(artifact.analysis);
      setTracking(artifact.tracking);
      setActiveEvent(artifact.analysis.events[0]);
      setStatus("completed");
      setProgress(100);
    }).catch((cause) => {
      if (!cancelled) setShowcaseError(cause instanceof Error ? cause.message : "展示作品暂时不可用");
    });
    return () => { cancelled = true; };
  }, [screen, showcase]);

  useEffect(() => () => releaseFrames(frames), [frames]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !tracking) return;
    let animationFrame = 0;
    const sync = () => {
      const frame = trackingFrameAt(tracking, video.currentTime);
      if (frame && frame.atSeconds !== trackingFrameTimeRef.current) {
        trackingFrameTimeRef.current = frame.atSeconds;
        setTrackingTime(video.currentTime);
      }
      if (!video.paused && !video.ended) animationFrame = window.requestAnimationFrame(sync);
    };
    const start = () => { window.cancelAnimationFrame(animationFrame); sync(); };
    video.addEventListener("play", start);
    video.addEventListener("seeked", start);
    start();
    return () => {
      window.cancelAnimationFrame(animationFrame);
      video.removeEventListener("play", start);
      video.removeEventListener("seeked", start);
    };
  }, [tracking, analysis, status]);

  const completed = status === "completed" && analysis;
  const currentStep = workflowSteps.findIndex((step) => step.status === status);
  const jobName = useMemo(() => showcase?.title ?? videoFile?.name.replace(/\.[^.]+$/, "") ?? "未命名回合", [showcase, videoFile]);

  const reset = () => {
    setStatus("draft"); setProgress(0); setAnalysis(undefined); setError(undefined); setActiveEvent(undefined); setFrames([]); setTracking(undefined); setTrackingTime(0); setLocalJobId(undefined); setIdentitySavingTrack(undefined);
  };

  const openWorkspace = () => {
    reset();
    setVideoFile(undefined); setShowcase(undefined); setVideoUrl(undefined);
    setShowcaseError(undefined);
    setScreen("workspace");
    window.history.pushState({}, "", `${window.location.pathname}?workspace=1`);
  };

  const openShowcase = () => {
    reset();
    setVideoFile(undefined); setShowcase(undefined); setVideoUrl(undefined);
    setShowcaseError(undefined);
    setScreen("showcase");
    window.history.pushState({}, "", window.location.pathname);
  };

  const run = async () => {
    if (!videoFile || isRunning) return;
    setError(undefined); setAnalysis(undefined); setIsRunning(true);
    try {
      let result: Analysis;
      if (mode === "cloud") {
        setStatus("extracting_frames"); setProgress(16);
        const extraction = await extractVideoFrames(videoFile, 6);
        setFrames(extraction.frames);
        result = await runCloudWorkflow({
          video: videoFile,
          data: dataFile,
          duration: extraction.duration,
          frames: extraction.frames,
          onProgress: (nextStatus, nextProgress) => { setStatus(nextStatus); setProgress(nextProgress); }
        });
      } else {
        const data = await parseDataFile(dataFile);
        const localRun = await runLocalVisionWorkflow({
          video: videoFile,
          data: dataFile,
          roster: rosterFile,
          onProgress: (nextStatus, nextProgress) => { setStatus(nextStatus); setProgress(nextProgress); }
        });
        const trackingResult = localRun.tracking;
        setLocalJobId(localRun.jobId);
        setTracking(trackingResult);
        result = createDemoAnalysis(videoFile.name, dataFile?.name ?? "built-in-demo.json", data);
        const playerTracks = trackingResult.tracks.filter((track) => track.role === "player").length;
        result.summary = `连续视觉以 ${trackingResult.video.processedFps.toFixed(1)} FPS 分析画面，得到 ${playerTracks} 条球员轨迹；身份需结合号码 OCR 和名单继续确认。`;
        result.warnings = [...trackingResult.warnings, ...result.warnings];
      }
      setAnalysis(result);
      setActiveEvent(result.events[0]);
    } catch (cause) {
      setStatus("failed"); setProgress(100);
      setError(cause instanceof Error ? cause.message : "无法读取数据文件");
    } finally {
      setIsRunning(false);
    }
  };

  const seekTo = (event: OverlayEvent) => {
    if (videoRef.current) {
      videoRef.current.currentTime = event.startSeconds;
      void videoRef.current.play();
    }
    setActiveEvent(event);
  };

  const updateOverlay = () => {
    const time = videoRef.current?.currentTime ?? 0;
    setTrackingTime(time);
    setActiveEvent(analysis?.events.find((event) => time >= event.startSeconds && time <= event.endSeconds));
  };

  const trackedFrame = trackingFrameAt(tracking, trackingTime);
  const roster = tracking?.roster;

  const speak = () => {
    const text = analysis?.narration.map((cue) => cue.text).join(" ");
    if (!text || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    window.speechSynthesis.speak(utterance);
  };

  const confirmIdentity = async (trackId: number, playerId: string | null) => {
    if (!localJobId || !tracking || identitySavingTrack !== undefined) return;
    setIdentitySavingTrack(trackId);
    setError(undefined);
    try {
      setTracking(await updateLocalTrackIdentity(localJobId, trackId, playerId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存身份确认");
    } finally {
      setIdentitySavingTrack(undefined);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Activity size={20} /></span><span>CourtVision<small>AGENT</small></span></div>
        <nav>
          <button className={`nav-item ${screen === "showcase" ? "active" : ""}`} onClick={openShowcase}><Film size={18} /><span>作品展示</span></button>
          <button className={`nav-item ${screen === "workspace" ? "active" : ""}`} onClick={openWorkspace}><LayoutDashboard size={18} /><span>新建分析</span></button>
          <button className="nav-item" disabled><Radio size={18} /><span>设备中心</span><small>预留</small></button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="cloud-state"><Cloud size={16} /><div><strong>{mode === "cloud" ? "AWS 托管模式" : "本地视觉模式"}</strong><small>{mode === "cloud" ? "AgentCore 已连接" : "连续检测与跟踪"}</small></div><span /></div>
        <div className="team-label">红细胞队 · Team28 · NBA x AWS</div>
      </aside>

      <main>
        <header className="topbar">
          <div><p>{screen === "showcase" ? "TEAM28 · PREGENERATED SHOWCASE" : "分析工作台"}</p><h1>{completed ? jobName : "创建比赛解读"}</h1></div>
          <div className="top-actions">
            <span className="region"><span /> us-east-1</span>
            {screen === "showcase" ? <button className="new-analysis-button" onClick={openWorkspace}><Sparkles size={15} />新建分析</button> : completed && <button className="icon-button" onClick={openWorkspace} title="新建分析"><RotateCcw size={18} /></button>}
          </div>
        </header>

        {screen === "showcase" && !completed ? (
          <div className="showcase-loading">
            <span className="eyebrow"><Activity size={14} /> TEAM28 · REVIEW READY</span>
            <h2>正在载入预生成作品</h2>
            {showcaseError ? <><p>{showcaseError}</p><button className="primary-button" onClick={openWorkspace}><Sparkles size={18} />进入分析工作台</button></> : <p>视频、轨迹与分析结果均为预生成产物，打开页面不会触发新任务。</p>}
          </div>
        ) : !completed ? (
          <div className="workspace create-view">
            <section className="intro-row">
              <div><span className="eyebrow"><Sparkles size={14} /> NEW ANALYSIS</span><h2>把一个回合，讲得明白。</h2><p>上传比赛片段与对应深度数据，系统会生成可核验的指标解读、时间轴和画面叠加方案。</p></div>
              <div className="pipeline-mini">
                <span><HardDriveUpload size={17} />输入</span><ChevronRight size={14} /><span><Cpu size={17} />Agent</span><ChevronRight size={14} /><span><Play size={17} />成片</span>
              </div>
            </section>

            <section className="upload-section">
              <div className="section-heading"><div><span>01</span><div><h3>输入素材</h3><p>视频是必需项；深度数据和比赛名单能提高解读与身份确认准确度。</p></div></div><span className="required"><i /> VIDEO REQUIRED</span></div>
              <div className="picker-grid">
                <FilePicker kind="video" file={videoFile} onChange={(file) => { setVideoFile(file); reset(); }} />
                <FilePicker kind="data" file={dataFile} onChange={(file) => { setDataFile(file); reset(); }} />
                <FilePicker kind="roster" file={rosterFile} onChange={(file) => { setRosterFile(file); reset(); }} />
              </div>
              {!dataFile && <div className="inline-note"><Info size={15} />{mode === "cloud" ? "未选择赛事数据时，Agent 只会给出明确标记的低置信度视觉估计。" : "未选择数据时使用内置示例指标，仅用于验证流程，结果会显著标注来源。"}</div>}
              {!rosterFile && mode === "local" && <div className="inline-note"><Users size={15} />未选择比赛名单时，系统会连续跟踪，但不会将轨迹编号映射为球员姓名。</div>}
            </section>

            <section className="configuration-section">
              <div className="section-heading"><div><span>02</span><div><h3>分析策略</h3><p>第一版聚焦赛事要求的三类核心指标。</p></div></div>
                <div className="mode-control" aria-label="分析模式">
                  <button className={mode === "local" ? "active" : ""} onClick={() => setMode("local")} disabled={isRunning}><Cpu size={14} />本地视觉</button>
                  <button className={mode === "cloud" ? "active" : ""} onClick={() => setMode("cloud")} disabled={!cloudAvailable || isRunning} title={cloudAvailable ? "使用 AWS AgentCore" : "部署到 AWS 后可用"}><Cloud size={14} />AgentCore</button>
                </div>
              </div>
              <div className="metric-options">
                {["预期命中率", "持球 / 无球引力", "胜负影响"].map((name, index) => {
                  const Icon = metricIcons[index]!;
                  return <div className="metric-option" key={name}><span><Icon size={19} /></span><div><strong>{name}</strong><small>{index === 0 ? "投篮质量与防守压力" : index === 1 ? "空间牵制与防守注意力" : "回合对比赛结果的贡献"}</small></div><Check size={16} /></div>;
                })}
              </div>
            </section>

            {status !== "draft" && (
              <section className={`progress-panel ${status === "failed" ? "failed" : ""}`}>
                <div className="progress-copy"><span>{status === "failed" ? <Info size={17} /> : <LoaderCircle size={17} className={isRunning ? "spin" : ""} />}{statusLabels[status]}</span><strong>{progress}%</strong></div>
                <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>
                <div className="step-row">{workflowSteps.slice(0, 5).map((step, index) => <span key={step.status} className={index <= currentStep ? "done" : ""}>{step.label}</span>)}</div>
                {error && <p className="error-text">{error}</p>}
              </section>
            )}

            <div className="run-row">
              <div>{mode === "cloud" ? <Wifi size={17} /> : <ShieldCheck size={17} />}<span>{mode === "cloud" ? "视频将抽取 6 张关键帧并交给 AgentCore 多模态分析。" : "本地模型将连续检测和跟踪球员，首次运行会下载模型。"}</span></div>
              <button className="primary-button" disabled={!videoFile || isRunning} onClick={run}>{isRunning ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}{isRunning ? "正在处理" : mode === "cloud" ? "开始智能识别" : "开始连续识别"}</button>
            </div>
          </div>
        ) : (
          <div className="workspace result-view">
            <div className="result-status"><span><Check size={14} /> {screen === "showcase" ? "TEAM28 · REVIEW RESULT" : "ANALYSIS COMPLETE"}</span><p>{analysis.summary}</p></div>
            <div className="result-grid">
              <section className="video-column">
                <div className={`video-stage ${tracking ? "has-tracking" : ""}`}>
                  <video ref={videoRef} src={videoUrl} controls onTimeUpdate={updateOverlay} onSeeked={updateOverlay} onPlay={updateOverlay} />
                  {tracking && <TrackingLayer players={trackedFrame?.players ?? []} ball={trackedFrame?.ball} />}
                  <Overlay event={activeEvent} />
                  {tracking && <span className="tracking-status"><i /> {trackedFrame?.players.filter((player) => player.role === "player").length ?? 0} PLAYERS · {tracking.video.processedFps.toFixed(1)} FPS</span>}
                  <span className="watermark"><Activity size={14} /> COURTVISION</span>
                </div>
                <div className="timeline">
                  <div className="timeline-head"><strong>事件时间轴</strong><span>{analysis.events.length} 个关键解读</span></div>
                  <div className="timeline-track">
                    {analysis.events.map((event) => <button key={event.id} className={`timeline-marker accent-${event.accent}`} style={{ left: `${Math.min(92, (event.startSeconds / 22) * 100)}%` }} onClick={() => seekTo(event)} title={event.title}><span /></button>)}
                  </div>
                </div>
                {frames.length > 0 && <div className="frame-strip"><div className="frame-strip-head"><span><Images size={14} />Agent 读取的关键帧</span><small>{frames.length} 帧</small></div><div>{frames.map((frame, index) => <button key={frame.previewUrl} onClick={() => { if (videoRef.current) videoRef.current.currentTime = frame.atSeconds; }}><img src={frame.previewUrl} alt={`关键帧 ${index + 1}`} /><span>{frame.atSeconds.toFixed(1)}s</span></button>)}</div></div>}
              </section>

              <aside className="insight-column">
                <div className="tabs">
                  <button className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")}>洞察</button>
                  <button className={activeTab === "evidence" ? "active" : ""} onClick={() => setActiveTab("evidence")}>依据</button>
                  <button className={activeTab === "identity" ? "active" : ""} onClick={() => setActiveTab("identity")}>身份</button>
                  <button className={activeTab === "device" ? "active" : ""} onClick={() => setActiveTab("device")}>解说设备</button>
                </div>
                {activeTab === "overview" && <div className="event-list">{analysis.events.map((event, index) => <button key={event.id} className={activeEvent?.id === event.id ? "active" : ""} onClick={() => seekTo(event)}><span className={`event-index accent-${event.accent}`}>0{index + 1}</span><div><small>{event.startSeconds.toFixed(1)}s · {event.metric.label}</small><strong>{event.title}</strong><p>{event.explanation}</p></div><b>{metricDisplay(event.metric)}</b></button>)}</div>}
                {activeTab === "evidence" && <div className="evidence-list">{analysis.events.map((event) => <div key={event.id}><span><Database size={16} /></span><div><strong>{event.title}</strong><p>{event.evidence.join("；")}</p><small>{event.metric.source}</small></div></div>)}</div>}
                {activeTab === "identity" && <div className="identity-review">
                  {roster ? <>
                    <div className="identity-heading"><BadgeCheck size={16} /><div><strong>身份校验</strong><small>人工确认会写回本地任务；标记为人工确认，不冒充 OCR。</small></div></div>
                    {tracking.tracks.filter((track) => track.role === "player").map((track) => <div className="identity-row" key={track.trackId}>
                      <span className={`identity-source ${track.identitySource}`}>{track.identitySource === "manual" ? "已确认" : track.identitySource === "ocr" ? "OCR" : "待确认"}</span>
                      <div><strong>{track.playerName ?? track.label}</strong><small>轨迹 {track.trackId} · {track.observations} 帧</small></div>
                      <select
                        aria-label={`确认轨迹 ${track.trackId} 的球员身份`}
                        value={track.playerId ?? ""}
                        disabled={identitySavingTrack !== undefined}
                        onChange={(event) => void confirmIdentity(track.trackId, event.target.value || null)}
                      >
                        <option value="">保持未确认</option>
                        {roster.players.map((player) => <option key={player.playerId} value={player.playerId}>{player.teamCode} · #{player.jerseyNumber} · {player.name}</option>)}
                      </select>
                    </div>)}
                    {error && <p className="error-text">{error}</p>}
                  </> : <div className="identity-empty"><Users size={19} /><p>本次任务未上传比赛名单，无法提供可确认的球员候选。</p></div>}
                </div>}
                {activeTab === "device" && <div className="device-panel"><div className="device-visual"><span><Radio size={28} /></span><i>•ᴗ•</i></div><h3>外接解说机器人</h3><p>云端 WebSocket 通道已纳入协议设计。当前可用浏览器语音预听解说稿。</p><div className="device-stats"><span><b>{analysis.narration.length}</b> 条语音</span><span><b>Opus</b> 预留编码</span></div><button onClick={speak}><Volume2 size={17} />预听完整解说</button><small><Link2 size={13} /> ESP32 尚未连接</small></div>}
              </aside>
            </div>
            <div className="result-footer"><span><BadgeCheck size={16} />红细胞队 · Team28</span><span><Mic2 size={16} />{analysis.narration.length} 条解说提示</span><span><Database size={16} />{analysis.provenance.dataFile}</span>{tracking && <span><Activity size={16} />{tracking.tracks.filter((track) => track.role === "player").length} 条球员轨迹</span>}{tracking?.roster && <span><Users size={16} />{tracking.roster.playerCount} 人名单已加载</span>}<span><ShieldCheck size={16} />{screen === "showcase" ? "预生成展示作品" : tracking ? `本地视觉 · ${tracking.model.device.toUpperCase()}` : analysis.generatedBy === "local-rules" ? "本地验证结果" : "AgentCore 多模态结果"}</span></div>
          </div>
        )}
      </main>
    </div>
  );
}
