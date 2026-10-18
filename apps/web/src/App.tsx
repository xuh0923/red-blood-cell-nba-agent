import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, BadgeCheck, BarChart3, Check, ChevronRight, CircleDot, Cpu, Database,
  FileJson, Film, Gauge, HardDriveUpload, Images, Info, LayoutDashboard,
  Bot, LoaderCircle, MessageCircle, Mic2, Play, RotateCcw, Send, ShieldCheck, Sparkles, Upload, Users
} from "lucide-react";
import {
  metricDisplay,
  type Analysis,
  type JobStatus,
  type OverlayEvent,
  type MatchResolution,
  type TrackingResult,
  type TrackedPlayer
} from "@courtvision/contracts";
import type { GameStatsSnapshot, GameStatsTimeline, TeamStats } from "@courtvision/contracts";
import { createDemoAnalysis, parseDataFile, parseStatsTimeline, workflowSteps } from "./demo-workflow";
import { releaseFrames, type ExtractedFrame } from "./video-frames";
import { runLocalVisionWorkflow, updateLocalTrackIdentity } from "./local-workflow";
import { loadShowcaseWorks, type ShowcaseArtifact } from "./showcase";
import { findStatsSnapshot, percentage } from "./stats";
import { extractMatchCandidates, resolveMatchIdentity } from "./match-resolution";
import { NBA_COURT, threePointArcPath, toCourtPoint } from "./court-geometry";

type Tab = "overview" | "evidence" | "identity";
type Screen = "showcase" | "workspace";
type StatsTab = "offense" | "defense" | "efficiency" | "state";

  const statusLabels: Record<JobStatus, string> = {
  draft: "等待输入", uploading: "准备本地任务", queued: "等待处理", extracting_frames: "读取视频帧",
  analyzing: "连续视觉分析", rendering: "生成叠加", publishing: "准备结果", completed: "分析完成", failed: "处理失败"
};
const metricIcons = [Gauge, Activity, BarChart3];

function FilePicker({ kind, file, onChange }: { kind: "video" | "data"; file?: File; onChange: (file?: File) => void }) {
  const isVideo = kind === "video";
  const Icon = isVideo ? Film : FileJson;
  return (
    <label className={`file-picker ${file ? "has-file" : ""}`}>
      <input
        type="file"
        aria-label={isVideo ? "比赛视频" : "比赛资料 JSON 或 CSV"}
        accept={isVideo ? "video/mp4,video/quicktime" : ".json,.csv,application/json,text/csv"}
        onChange={(event) => onChange(event.target.files?.[0])}
      />
      <span className="file-icon"><Icon size={22} /></span>
      <span className="file-copy">
        <strong>{file?.name ?? (isVideo ? "选择比赛视频" : "选择比赛资料")}</strong>
        <small>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : (isVideo ? "MP4 / MOV，建议 30 秒以内" : "JSON / CSV，Agent 自动判断数据内容")}</small>
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
  const layerRef = useRef<HTMLDivElement>(null);
  const [videoRect, setVideoRect] = useState({ left: 0, top: 0, width: 100, height: 100 });
  useEffect(() => {
    const layer = layerRef.current;
    const video = layer?.parentElement?.querySelector("video");
    if (!layer || !(video instanceof HTMLVideoElement)) return;
    const update = () => {
      const container = layer.getBoundingClientRect();
      const naturalWidth = video.videoWidth || 16;
      const naturalHeight = video.videoHeight || 9;
      const scale = Math.min(container.width / naturalWidth, container.height / naturalHeight);
      const width = naturalWidth * scale;
      const height = naturalHeight * scale;
      setVideoRect({ left: (container.width - width) / container.width * 100, top: (container.height - height) / container.height * 100, width: width / container.width * 100, height: height / container.height * 100 });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(layer);
    video.addEventListener("loadedmetadata", update);
    return () => { observer.disconnect(); video.removeEventListener("loadedmetadata", update); };
  }, []);
  const place = (x: number, y: number) => ({ left: `${videoRect.left + x * videoRect.width}%`, top: `${videoRect.top + y * videoRect.height}%` });
  return (
    <div ref={layerRef} className="tracking-layer" aria-label="连续球员跟踪">
      {players.map((player) => {
        const label = player.role === "referee-candidate" ? "裁判候选" : player.playerName ?? (player.jerseyNumber ? `#${player.jerseyNumber}` : `T${String(player.trackId).padStart(2, "0")}`);
        return (
          <div
            className={`player-track ${player.team} ${player.role}`}
            key={player.trackId}
            style={{
              ...place(player.box.x, player.box.y),
              width: `${player.box.width * videoRect.width}%`,
              height: `${player.box.height * videoRect.height}%`
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
            ...place(ball.box.x + ball.box.width / 2, ball.box.y + ball.box.height / 2)
          }}
          title={`篮球置信度 ${Math.round(ball.confidence * 100)}%`}
        />
      )}
    </div>
  );
}

function CourtRadar({ frame, trackingTime, period, gameClock, shotClock, dataStatus, eventTitle, shotResult }: {
  frame?: TrackingResult["frames"][number];
  trackingTime: number;
  period?: number;
  gameClock?: string;
  shotClock?: string;
  dataStatus?: string;
  eventTitle?: string;
  shotResult?: "made" | "missed";
}) {
  const [viewMode, setViewMode] = useState<"full" | "half">("full");
  const [selectedTrackId, setSelectedTrackId] = useState<number>();
  const sourcePoint = (entity: { courtPosition?: { x: number; y: number }; courtCoordinates?: { x: number; y: number } }) => toCourtPoint(entity.courtPosition ?? entity.courtCoordinates);
  const visiblePlayers = (frame?.players ?? []).filter((player) => sourcePoint(player));
  const visibleBall = frame?.ball && sourcePoint(frame.ball) ? frame.ball : undefined;
  const selectedPlayer = visiblePlayers.find((player) => player.trackId === selectedTrackId);
  const visibleTrajectories = (frame?.trajectories ?? []).map((trajectory) => trajectory.points.map(toCourtPoint).filter((point): point is { x: number; y: number } => Boolean(point))).filter((points) => points.length > 1);
  const visibleSpaceZones = (frame?.spaceZones ?? []).map((zone) => ({ zone, center: toCourtPoint(zone.center) })).filter((item): item is { zone: typeof item.zone; center: { x: number; y: number } } => Boolean(item.center));
  const numberFor = (player: TrackedPlayer) => {
    if (player.jerseyNumber?.trim()) return player.jerseyNumber;
    return `T${String(player.trackId).padStart(2, "0")}`;
  };
  const selectedLabel = selectedPlayer ? `#${numberFor(selectedPlayer)} · ${eventTitle ?? "已选球员"}` : eventTitle ?? "等待战术事件";
  const formatTrackingTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
  const hasUncalibratedData = Boolean(frame && (frame.players.some((player) => !sourcePoint(player)) || (frame.ball && !sourcePoint(frame.ball))));
  const coordinateMode = visiblePlayers.length || visibleBall ? "球场标定坐标" : hasUncalibratedData ? "尚未完成球场标定" : "等待当前帧";
  const hasFrameData = Boolean(visiblePlayers.length || visibleBall);
  return (
    <section className="radar-panel" aria-label="球场雷达">
      <div className="radar-topbar">
        <div className="panel-title"><span><Activity size={15} />球场雷达</span><small>战术视角</small></div>
        <div className="radar-view-toggle" role="group" aria-label="球场范围">
          <button className={viewMode === "full" ? "active" : ""} onClick={() => setViewMode("full")}>全场</button>
          <button className={viewMode === "half" ? "active" : ""} onClick={() => setViewMode("half")}>半场</button>
        </div>
      </div>
      <div className={`basketball-court ${viewMode === "half" ? "half-court" : ""}`}>
        <svg className="court-svg" viewBox={viewMode === "full" ? "0 0 94 50" : "0 0 47 50"} preserveAspectRatio="xMidYMid meet" role="img" aria-label={viewMode === "full" ? "标准全场篮球场" : "标准左半场篮球场"}>
          <defs>
            <linearGradient id="court-zone" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#65c5d4" stopOpacity=".18" /><stop offset="1" stopColor="#65c5d4" stopOpacity="0" /></linearGradient>
          </defs>
          <rect className="court-floor" x="0" y="0" width={NBA_COURT.length} height={NBA_COURT.width} rx="1" />
          <g className="court-lines">
            <rect x="0" y="0" width="94" height="50" /><path d="M47 0V50" /><circle cx="47" cy="25" r="6" /><circle className="court-center-dot" cx="47" cy="25" r=".35" />
            <rect x="0" y="17" width="19" height="16" /><rect x="75" y="17" width="19" height="16" />
            <circle cx="19" cy="25" r="6" /><circle cx="75" cy="25" r="6" className="court-dashed" />
            <path d={threePointArcPath(NBA_COURT.leftRimX, "left")} /><path d={threePointArcPath(NBA_COURT.rightRimX, "right")} />
            <path d="M 0 3 H 14.198 M 0 47 H 14.198 M 79.802 3 H 94 M 79.802 47 H 94" />
            <path d="M 4 22 H 4 M 90 22 H 90" /><path d="M 4 22 V 28 M 90 22 V 28" />
            <circle cx={NBA_COURT.leftRimX} cy="25" r={NBA_COURT.rimRadius} /><circle cx={NBA_COURT.rightRimX} cy="25" r={NBA_COURT.rimRadius} />
            <path className="restricted-area" d="M 5.25 21 A 4 4 0 0 1 5.25 29 M 88.75 21 A 4 4 0 0 0 88.75 29" />
          </g>
          {visibleSpaceZones.map(({ zone, center }, index) => <ellipse key={`space-${index}`} className="court-space-zone" cx={center.x} cy={center.y} rx={zone.radiusX <= 1 ? zone.radiusX * NBA_COURT.length : zone.radiusX} ry={zone.radiusY <= 1 ? zone.radiusY * NBA_COURT.width : zone.radiusY} fill="url(#court-zone)" />)}
          {visibleTrajectories.map((points, index) => <polyline key={`trajectory-${index}`} className="court-trajectory" points={points.map((point) => `${point.x},${point.y}`).join(" ")} />)}
          <g className="radar-entities">
            {visiblePlayers.map((player) => { const point = sourcePoint(player)!; return <g key={player.trackId} className={`radar-player ${player.team} ${player.role} ${selectedTrackId === player.trackId ? "selected" : ""} ${selectedTrackId !== undefined && selectedTrackId !== player.trackId ? "dimmed" : ""}`} role="button" tabIndex={0} onClick={() => setSelectedTrackId((current) => current === player.trackId ? undefined : player.trackId)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedTrackId((current) => current === player.trackId ? undefined : player.trackId); }} aria-label={`选择球员 ${numberFor(player)}，${player.playerName ?? "身份未确认"}`}><circle cx={point.x} cy={point.y} r="1.15" /><circle className="marker-halo" cx={point.x} cy={point.y} r="1.8" /><text x={point.x} y={point.y + .35}>{numberFor(player)}</text></g>; })}
            {visibleBall && <g className="radar-ball" aria-label="篮球位置"><circle cx={sourcePoint(visibleBall)!.x} cy={sourcePoint(visibleBall)!.y} r=".7" /><circle className="marker-halo" cx={sourcePoint(visibleBall)!.x} cy={sourcePoint(visibleBall)!.y} r="1.2" /></g>}
          </g>
        </svg>
        <div className="radar-hud radar-hud-top-left"><strong>{gameClock ?? formatTrackingTime(trackingTime)}</strong><small>{shotClock ? `进攻时间 ${shotClock}` : period ? `第 ${period} 节` : "视频时间"}</small></div>
        <div className="radar-hud radar-hud-top-center"><span>战术视角</span></div>
        <div className="radar-hud radar-hud-top-right"><strong>{dataStatus ?? "等待跟踪数据"}</strong><small>{coordinateMode}</small></div>
        {!hasFrameData && <div className="radar-empty">{hasUncalibratedData ? "尚未完成球场标定" : frame ? "当前时刻无可见目标" : "等待当前帧"}</div>}
        <div className="radar-court-label">NBA COURT · {viewMode === "full" ? "FULL COURT" : "LEFT HALF"}</div>
        <div className="radar-hud radar-hud-bottom-left"><span><i className="team-a-dot" />球队 A</span><span><i className="team-b-dot" />球队 B</span><span><i className="ball-dot" />篮球</span></div>
        <div className="radar-event-capsule"><strong>{selectedLabel}</strong>{shotResult ? <em>{shotResult === "made" ? "结构化数据：命中" : "结构化数据：未中"}</em> : !eventTitle && <span>等待当前事件</span>}</div>
      </div>
    </section>
  );
}

function StatsDashboard({ snapshot, matchResolution, isDemo, tab, onTabChange }: { snapshot?: GameStatsSnapshot; matchResolution?: MatchResolution; isDemo?: boolean; tab: StatsTab; onTabChange: (tab: StatsTab) => void }) {
  const left = snapshot?.teams[0];
  const right = snapshot?.teams[1];
  const labels: Record<StatsTab, string> = { offense: "进攻", defense: "防守", efficiency: "效率", state: "比赛状态" };
  const rows: Array<{ label: string; left?: number; right?: number; percent?: boolean; display?: (team: TeamStats) => string | undefined }> = left && right ? ({
    offense: [
      { label: "总投篮", left: left.fieldGoals?.made, right: right.fieldGoals?.made, display: (team: TeamStats) => team.fieldGoals ? `${team.fieldGoals.made} / ${team.fieldGoals.attempted}` : undefined },
      { label: "三分球", left: left.threePoints?.made, right: right.threePoints?.made, display: (team: TeamStats) => team.threePoints ? `${team.threePoints.made} / ${team.threePoints.attempted}` : undefined },
      { label: "罚球", left: left.freeThrows?.made, right: right.freeThrows?.made, display: (team: TeamStats) => team.freeThrows ? `${team.freeThrows.made} / ${team.freeThrows.attempted}` : undefined },
      { label: "助攻", left: left.assists, right: right.assists }, { label: "失误", left: left.turnovers, right: right.turnovers }
    ],
    defense: [
      { label: "总篮板", left: left.rebounds ? left.rebounds.offensive + left.rebounds.defensive : undefined, right: right.rebounds ? right.rebounds.offensive + right.rebounds.defensive : undefined },
      { label: "进攻篮板", left: left.rebounds?.offensive, right: right.rebounds?.offensive }, { label: "防守篮板", left: left.rebounds?.defensive, right: right.rebounds?.defensive },
      { label: "抢断", left: left.steals, right: right.steals }, { label: "盖帽", left: left.blocks, right: right.blocks }
    ],
    efficiency: [
      { label: "投篮命中率", percent: true, left: percentage(left.fieldGoals?.made, left.fieldGoals?.attempted), right: percentage(right.fieldGoals?.made, right.fieldGoals?.attempted), display: (team: TeamStats) => percentage(team.fieldGoals?.made, team.fieldGoals?.attempted) === undefined ? undefined : `${percentage(team.fieldGoals?.made, team.fieldGoals?.attempted)}%` },
      { label: "三分命中率", percent: true, left: percentage(left.threePoints?.made, left.threePoints?.attempted), right: percentage(right.threePoints?.made, right.threePoints?.attempted), display: (team: TeamStats) => percentage(team.threePoints?.made, team.threePoints?.attempted) === undefined ? undefined : `${percentage(team.threePoints?.made, team.threePoints?.attempted)}%` },
      { label: "罚球命中率", percent: true, left: percentage(left.freeThrows?.made, left.freeThrows?.attempted), right: percentage(right.freeThrows?.made, right.freeThrows?.attempted), display: (team: TeamStats) => percentage(team.freeThrows?.made, team.freeThrows?.attempted) === undefined ? undefined : `${percentage(team.freeThrows?.made, team.freeThrows?.attempted)}%` },
      { label: "进攻效率", left: left.offensiveRating, right: right.offensiveRating }, { label: "防守效率", left: left.defensiveRating, right: right.defensiveRating }
    ],
    state: [
      { label: "本节犯规", left: left.fouls?.period, right: right.fouls?.period, display: (team: TeamStats) => team.fouls ? `${team.fouls.period} / ${team.fouls.game}` : undefined },
      { label: "内线得分", left: left.paintPoints, right: right.paintPoints }, { label: "快攻得分", left: left.fastBreakPoints, right: right.fastBreakPoints },
      { label: "二次进攻", left: left.secondChancePoints, right: right.secondChancePoints }, { label: "最大分差", left: left.largestLead, right: right.largestLead }
    ]
  }[tab] ?? []) : [];
  return <section className="stats-dashboard" aria-label="篮球比赛数据仪表盘">
    <div className="stats-head"><div><strong>比赛数据</strong><small>{snapshot ? `${snapshot.period ? `第 ${snapshot.period} 节 · ` : ""}${snapshot.clock ?? "时间同步"}` : matchResolution?.status === "confirmed" ? "比赛已确认，等待官方统计" : "暂无结构化比赛数据"}</small></div><span>{isDemo ? "示例数据" : snapshot ? "数据快照" : matchResolution?.status === "confirmed" ? "身份已确认" : "等待数据源"}</span></div>
    <div className="stats-tabs">{(Object.keys(labels) as StatsTab[]).map((key) => <button key={key} className={tab === key ? "active" : ""} onClick={() => onTabChange(key)}>{labels[key]}</button>)}</div>
    {snapshot && left && right ? <>
      <div className="stats-score"><span>{left.teamCode}<b>{left.score}</b></span><i>:</i><span><b>{right.score}</b>{right.teamCode}</span></div>
      <div className="stat-rows">{rows.filter((row) => row.left !== undefined || row.right !== undefined).map((row) => { const max = row.percent ? 100 : Math.max(row.left ?? 0, row.right ?? 0, 1); return <div className="stat-row" key={row.label}><span>{row.display?.(left) ?? (row.left ?? "—")}</span><div><strong>{row.label}</strong><i><em style={{ width: `${(row.left ?? 0) / max * 100}%` }} /><b style={{ width: `${(row.right ?? 0) / max * 100}%` }} /></i></div><span>{row.display?.(right) ?? (row.right ?? "—")}</span></div>; })}</div>
    </> : <div className="stats-empty"><Database size={17} /><p>未加载 Box Score / Play-by-Play 数据。视觉模型不会推断比分、命中率或犯规。</p></div>}
  </section>;
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
  const [screen, setScreen] = useState<Screen>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("workspace") === "1") return "workspace";
    return "showcase";
  });
  const [showcase, setShowcase] = useState<ShowcaseArtifact>();
  const [showcaseWorks, setShowcaseWorks] = useState<ShowcaseArtifact[]>([]);
  const [showcaseLoaded, setShowcaseLoaded] = useState(false);
  const [showcaseError, setShowcaseError] = useState<string>();
  const [statsTimeline, setStatsTimeline] = useState<GameStatsTimeline>();
  const [matchResolution, setMatchResolution] = useState<MatchResolution>();
  const [statsTab, setStatsTab] = useState<StatsTab>("offense");
  const [videoFile, setVideoFile] = useState<File>();
  const [dataFile, setDataFile] = useState<File>();
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
  const [videoDuration, setVideoDuration] = useState(0);
  const [agentQuestion, setAgentQuestion] = useState("");
  const [agentReply, setAgentReply] = useState("我已加载当前回合的视觉轨迹、统计快照和分析证据。当前问答只使用这些已加载数据，不会补猜缺失的比赛信息。");
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackingFrameTimeRef = useRef(-1);
  const requestedWorkIdRef = useRef(new URLSearchParams(window.location.search).get("work") ?? undefined);

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
    if (screen !== "showcase" || showcaseLoaded) return;
    let cancelled = false;
    void loadShowcaseWorks().then((works) => {
      if (cancelled) return;
      setShowcaseWorks(works);
      setShowcaseLoaded(true);
      const artifact = works.find((work) => work.id === requestedWorkIdRef.current) ?? works[0];
      if (!artifact) {
        setShowcaseError("还没有本地展示作品。完成一次分析后，可用 showcase:prepare 生成展示产物。");
        return;
      }
      setShowcase(artifact);
      setVideoUrl(artifact.videoUrl);
      setAnalysis(artifact.analysis);
      setTracking(artifact.tracking);
      setStatsTimeline(artifact.stats);
      setMatchResolution(artifact.stats?.matchResolution);
      setActiveEvent(artifact.analysis.events[0]);
      setStatus("completed");
      setProgress(100);
    }).catch((cause) => {
      if (!cancelled) {
        setShowcaseLoaded(true);
        setShowcaseError(cause instanceof Error ? cause.message : "展示作品暂时不可用");
      }
    });
    return () => { cancelled = true; };
  }, [screen, showcaseLoaded]);

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
    setStatus("draft"); setProgress(0); setAnalysis(undefined); setError(undefined); setActiveEvent(undefined); setFrames([]); setTracking(undefined); setTrackingTime(0); setVideoDuration(0); setLocalJobId(undefined); setIdentitySavingTrack(undefined); setStatsTimeline(undefined); setMatchResolution(undefined); setStatsTab("offense");
  };

  const openWorkspace = () => {
    reset();
    setVideoFile(undefined); setShowcase(undefined); setVideoUrl(undefined);
    setShowcaseError(undefined);
    setScreen("workspace");
    window.history.pushState({}, "", `${window.location.pathname}?workspace=1`);
  };

  const openShowcase = (workId?: string) => {
    reset();
    setVideoFile(undefined); setShowcase(undefined); setVideoUrl(undefined);
    setShowcaseWorks([]); setShowcaseLoaded(false);
    setShowcaseError(undefined);
    requestedWorkIdRef.current = workId;
    setScreen("showcase");
    window.history.pushState({}, "", workId ? `${window.location.pathname}?work=${encodeURIComponent(workId)}` : window.location.pathname);
  };

  const selectShowcase = (artifact: ShowcaseArtifact) => {
    setShowcase(artifact);
    setVideoUrl(artifact.videoUrl);
    setAnalysis(artifact.analysis);
    setTracking(artifact.tracking);
    setStatsTimeline(artifact.stats);
    setMatchResolution(artifact.stats?.matchResolution);
    setActiveEvent(artifact.analysis.events[0]);
    setTrackingTime(0);
    setVideoDuration(artifact.durationSeconds);
    setStatus("completed");
    setProgress(100);
    requestedWorkIdRef.current = artifact.id;
    window.history.replaceState({}, "", `${window.location.pathname}?work=${encodeURIComponent(artifact.id)}`);
  };

  const run = async () => {
    if (!videoFile || isRunning) return;
    setError(undefined); setAnalysis(undefined); setIsRunning(true);
    try {
      const data = await parseDataFile(dataFile);
      const localRun = await runLocalVisionWorkflow({
        video: videoFile,
        data: dataFile,
        onProgress: (nextStatus, nextProgress) => { setStatus(nextStatus); setProgress(nextProgress); }
      });
      const trackingResult = localRun.tracking;
      setLocalJobId(localRun.jobId);
      setTracking(trackingResult);
      setStatsTimeline(parseStatsTimeline(data));
      const resolution = resolveMatchIdentity(trackingResult.videoEvidence, extractMatchCandidates(data));
      setMatchResolution(resolution);
      const result = createDemoAnalysis(videoFile.name, dataFile?.name ?? "built-in-demo.json", data);
      const playerTracks = trackingResult.tracks.filter((track) => track.role === "player").length;
      result.summary = `连续视觉以 ${trackingResult.video.processedFps.toFixed(1)} FPS 分析画面，得到 ${playerTracks} 条球员轨迹；身份需结合号码 OCR 和名单继续确认。`;
      result.warnings = [...trackingResult.warnings, ...resolution.warnings, ...result.warnings];
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
  const radarFrame = trackedFrame;
  const statsSnapshot = findStatsSnapshot(statsTimeline, trackingTime);
  const roster = tracking?.roster;
  const playerTracks = tracking?.tracks.filter((track) => track.role === "player") ?? [];
  const visiblePlayers = trackedFrame?.players.filter((player) => player.role === "player") ?? [];
  const visibleTeamA = visiblePlayers.filter((player) => player.team === "team-a").length;
  const visibleTeamB = visiblePlayers.filter((player) => player.team === "team-b").length;
  const averageConfidence = visiblePlayers.length ? Math.round(visiblePlayers.reduce((sum, player) => sum + player.confidence, 0) / visiblePlayers.length * 100) : 0;

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

  const askAgent = (question?: string) => {
    const prompt = (question ?? agentQuestion).trim();
    if (!prompt) return;
    setAgentQuestion("");
    if (/投篮|三分|命中率|犯规|得分|篮板|助攻|失误/.test(prompt) && statsSnapshot) {
      const [left, right] = statsSnapshot.teams;
      const leftRate = percentage(left?.fieldGoals?.made, left?.fieldGoals?.attempted);
      const rightRate = percentage(right?.fieldGoals?.made, right?.fieldGoals?.attempted);
      setAgentReply(`${left?.teamCode} ${left?.score} 分，投篮命中率 ${leftRate ?? "-"}%；${right?.teamCode} ${right?.score} 分，投篮命中率 ${rightRate ?? "-"}%。${leftRate !== undefined && rightRate !== undefined ? (leftRate >= rightRate ? left?.teamCode : right?.teamCode) : "数据"} 当前效率更高。`);
    } else if (/人数|谁在场|球员/.test(prompt)) {
      setAgentReply(`当前帧可见 ${visiblePlayers.length} 名球员，其中球队 A ${visibleTeamA} 人、球队 B ${visibleTeamB} 人；结果来自 ${tracking?.video.processedFps.toFixed(1) ?? "-"} FPS 连续跟踪。`);
    } else if (/稳定|轨迹|跟踪/.test(prompt)) {
      setAgentReply(`该片段保留 ${playerTracks.length} 条球员轨迹，当前画面平均检测置信度为 ${averageConfidence}%。遮挡或镜头变化可能产生轨迹片段，姓名确认仍需号码 OCR 或人工校验。`);
    } else if (/洞察|指标|战术|回合/.test(prompt)) {
      const event = activeEvent ?? analysis?.events[0];
      setAgentReply(event ? `${event.title}：${event.explanation} 当前指标为 ${metricDisplay(event.metric)} ${event.metric.label}。` : "当前没有可用的结构化洞察事件。");
    } else {
      setAgentReply(`已收到“${prompt}”。当前本地问答仅基于已加载的轨迹与分析证据回答，不会补猜缺失的比赛信息。`);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Activity size={20} /></span><span>CourtVision<small>AGENT</small></span></div>
        <nav>
          <button className={`nav-item ${screen === "showcase" ? "active" : ""}`} onClick={() => openShowcase()}><Film size={18} /><span>作品展示</span></button>
          <button className={`nav-item ${screen === "workspace" ? "active" : ""}`} onClick={openWorkspace}><LayoutDashboard size={18} /><span>素材导入</span></button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="cloud-state"><Cpu size={16} /><div><strong>本地视觉模式</strong><small>连续检测与跟踪</small></div><span /></div>
        <div className="team-label">红细胞队 · Team28 · NBA</div>
      </aside>

      <main>
        <header className="topbar">
          <div><p>{screen === "showcase" ? "TEAM28 · LOCAL ANALYSIS LIBRARY" : "素材导入与分析"}</p><h1>{completed ? jobName : screen === "workspace" ? "创建比赛解读" : "作品展示"}</h1></div>
          <div className="top-actions">
            {screen === "showcase" ? <button className="new-analysis-button" onClick={openWorkspace}><HardDriveUpload size={15} />素材导入</button> : completed && <button className="icon-button" onClick={openWorkspace} title="新建分析"><RotateCcw size={18} /></button>}
          </div>
        </header>

        {screen === "showcase" && !completed ? (
          <div className="showcase-loading">
            <span className="eyebrow"><Activity size={14} /> TEAM28 · WORK LIBRARY</span>
            <h2>{showcaseLoaded ? "暂无可展示作品" : "正在载入已完成作品"}</h2>
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
              <div className="section-heading"><div><span>01</span><div><h3>输入素材</h3><p>视频是必需项；比赛资料可包含深度指标、球队阵容或二者的组合数据。</p></div></div><span className="required"><i /> VIDEO REQUIRED</span></div>
              <div className="picker-grid">
                <FilePicker kind="video" file={videoFile} onChange={(file) => { setVideoFile(file); reset(); }} />
                <FilePicker kind="data" file={dataFile} onChange={(file) => { setDataFile(file); reset(); }} />
              </div>
              {!dataFile && <div className="inline-note"><Info size={15} />未选择比赛资料时不会生成 xFG、引力或胜负影响指标；视觉跟踪仍可运行，球员身份保持未确认。</div>}
            </section>

            <section className="configuration-section">
              <div className="section-heading"><div><span>02</span><div><h3>分析策略</h3><p>第一版聚焦赛事要求的三类核心指标。</p></div></div>
              <span className="local-mode-badge"><Cpu size={14} />本地连续视觉</span>
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
              <div><ShieldCheck size={17} /><span>本地模型将连续检测和跟踪球员，首次运行会下载模型。</span></div>
              <button className="primary-button" disabled={!videoFile || isRunning} onClick={run}>{isRunning ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}{isRunning ? "正在处理" : "开始连续识别"}</button>
            </div>
          </div>
        ) : (
          <div className="workspace result-view">
            {screen === "showcase" && showcase && (
              <div className="work-selector">
                <div><Film size={16} /><span><strong>已完成作品</strong><small>共 {showcaseWorks.length} 个不同视频</small></span></div>
                <select aria-label="选择已分析作品" value={showcase.id} onChange={(event) => {
                  const selected = showcaseWorks.find((work) => work.id === event.currentTarget.value);
                  if (selected) selectShowcase(selected);
                }}>
                  {showcaseWorks.map((work) => <option key={work.id} value={work.id}>{work.title} · {new Date(work.updatedAt).toLocaleString("zh-CN")}</option>)}
                </select>
              </div>
            )}
            <div className="result-status"><span><Check size={14} /> {screen === "showcase" ? "TEAM28 · REVIEW RESULT" : "ANALYSIS COMPLETE"}</span><p>{analysis.summary}</p></div>
            <div className="result-grid">
              <section className="video-column">
                <div className={`video-stage ${tracking ? "has-tracking" : ""}`}>
                  <video ref={videoRef} src={videoUrl} poster={frames[0]?.previewUrl} controls preload="metadata" playsInline onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration)} onTimeUpdate={updateOverlay} onSeeked={updateOverlay} onPlay={updateOverlay} onEnded={updateOverlay} />
                  {tracking && <TrackingLayer players={trackedFrame?.players ?? []} ball={trackedFrame?.ball} />}
                  <Overlay event={activeEvent} />
                  {tracking && <span className="tracking-status"><i /> {trackedFrame?.players.filter((player) => player.role === "player").length ?? 0} PLAYERS · {tracking.video.processedFps.toFixed(1)} FPS</span>}
                  <span className="watermark"><Activity size={14} /> COURTVISION</span>
                </div>
                <div className="timeline">
                  <div className="timeline-head"><strong>事件时间轴</strong><span>{analysis.events.length} 个关键解读</span></div>
                  <div className="timeline-track">
                    <input className="timeline-scrubber" type="range" min="0" max={Math.max(videoDuration || tracking?.video.durationSeconds || 1, 1)} step="0.01" value={Math.min(trackingTime, videoDuration || tracking?.video.durationSeconds || 1)} aria-label="视频时间轴" onChange={(event) => { const next = Number(event.currentTarget.value); if (videoRef.current) videoRef.current.currentTime = next; updateOverlay(); }} />
                    {analysis.events.map((event) => <button key={event.id} className={`timeline-marker accent-${event.accent}`} style={{ left: `${Math.min(100, (event.startSeconds / Math.max(videoDuration || tracking?.video.durationSeconds || 1, 1)) * 100)}%` }} onClick={() => seekTo(event)} title={event.title}><span /></button>)}
                  </div>
                </div>
                <StatsDashboard snapshot={statsSnapshot} matchResolution={matchResolution} isDemo={statsTimeline?.isDemo} tab={statsTab} onTabChange={setStatsTab} />
                {frames.length > 0 && <div className="frame-strip"><div className="frame-strip-head"><span><Images size={14} />Agent 读取的关键帧</span><small>{frames.length} 帧</small></div><div>{frames.map((frame, index) => <button key={frame.previewUrl} onClick={() => { if (videoRef.current) videoRef.current.currentTime = frame.atSeconds; }}><img src={frame.previewUrl} alt={`关键帧 ${index + 1}`} /><span>{frame.atSeconds.toFixed(1)}s</span></button>)}</div></div>}
              </section>

              <aside className="insight-column broadcast-aside">
                <CourtRadar frame={radarFrame} trackingTime={trackingTime} period={statsSnapshot?.period} gameClock={statsSnapshot?.clock} dataStatus={radarFrame ? "FRAME SYNC" : tracking ? "NO FRAME" : "WAITING"} eventTitle={activeEvent?.title} />
                <section className="current-insight" aria-label="当前战术解读">
                  <div className="section-kicker"><Sparkles size={14} />当前解读</div>
                  {activeEvent ? <><h3>{activeEvent.title}</h3><strong className="insight-metric">{metricDisplay(activeEvent.metric)} <small>{activeEvent.metric.label}</small></strong><p>{activeEvent.explanation}</p><small className="insight-source">依据：{activeEvent.metric.source} · {activeEvent.metric.confidence !== undefined ? `置信度 ${Math.round(activeEvent.metric.confidence * 100)}%` : "结构化事件"}</small></> : <p className="insight-waiting">等待视频进入一个有结构化依据的事件。</p>}
                </section>
                <section className="agent-panel">
                <div className="agent-title"><span><Bot size={17} />赛场问答</span><i className="local" /><small>基于已加载数据与已生成证据</small></div>
                <div className="tabs agent-tabs">
                  <button className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")}>问答</button>
                  <button className={activeTab === "evidence" ? "active" : ""} onClick={() => setActiveTab("evidence")}>依据</button>
                  <button className={activeTab === "identity" ? "active" : ""} onClick={() => setActiveTab("identity")}>身份</button>
                </div>
                {activeTab === "overview" && <div className="chat-panel"><div className="chat-answer"><Bot size={15} /><p>{agentReply}</p></div><div className="quick-questions"><button onClick={() => askAgent("当前场上有多少球员？")}>当前谁在场？</button><button onClick={() => askAgent("轨迹跟踪稳定吗？")}>跟踪稳定吗？</button><button onClick={() => askAgent("当前洞察是什么？")}>当前洞察</button></div><form className="agent-input" onSubmit={(event) => { event.preventDefault(); askAgent(); }}><input aria-label="向赛场问答提问" value={agentQuestion} onChange={(event) => setAgentQuestion(event.target.value)} placeholder="问问这个回合..." /><button type="submit" title="发送问题"><Send size={15} /></button></form></div>}
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
                </section>
              </aside>
            </div>
              <div className="result-footer"><span><BadgeCheck size={16} />红细胞队 · Team28</span><span><Mic2 size={16} />{analysis.narration.length} 条解说提示</span><span><Database size={16} />{analysis.provenance.dataFile}</span>{tracking && <span><Activity size={16} />{tracking.tracks.filter((track) => track.role === "player").length} 条球员轨迹</span>}{tracking?.quality && <span><Gauge size={16} />画面覆盖 {Math.round(tracking.quality.frameCoverage * 100)}% · 篮球 {Math.round(tracking.quality.ballFrameCoverage * 100)}%</span>}{tracking?.roster && <span><Users size={16} />{tracking.roster.playerCount} 人名单已加载</span>}{matchResolution && <span><ShieldCheck size={16} />比赛身份：{matchResolution.status === "confirmed" ? "已确认" : matchResolution.status === "ambiguous" ? "待复核" : "未确认"}</span>}<span><ShieldCheck size={16} />{screen === "showcase" ? "本地展示产物" : tracking ? `本地视觉 · ${tracking.model.device.toUpperCase()}` : "本地验证结果"}</span></div>
          </div>
        )}
      </main>
    </div>
  );
}
