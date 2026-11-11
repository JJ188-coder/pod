const STYLE = `
:root {
  color-scheme: light dark;
  --bg: light-dark(#f7f7f5, #131315);
  --panel: light-dark(#ffffff, #1c1c20);
  --text: light-dark(#1b1b1f, #f2f2f4);
  --muted: light-dark(#61616b, #a3a3ad);
  --line: light-dark(#e4e4e9, #2e2e34);
  --track: light-dark(#ececf0, #2a2a30);
  --accent: light-dark(#2f6fed, #7aa2ff);
  --warn: light-dark(#9a5b00, #ffbf66);
  --bad: light-dark(#b42318, #ff8a80);
  --good: light-dark(#127a4a, #66d9a3);
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body {
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif;
  padding: 28px 20px 48px;
}
.page { max-width: 880px; margin: 0 auto; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; letter-spacing: .01em; }
h2 { font-size: 15px; font-weight: 600; margin: 0; }
.batch { margin: 0; color: var(--muted); font-size: 13px; }
.pill {
  display: inline-block; padding: 4px 10px; border-radius: 999px;
  background: var(--track); color: var(--muted); font-size: 12px; white-space: nowrap;
}
.pill.live { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
.pill.good { background: color-mix(in srgb, var(--good) 16%, transparent); color: var(--good); }
.pill.bad { background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad); }
.pill.warn { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
.notice { min-height: 20px; margin: 14px 0 0; color: var(--muted); font-size: 13px; }
.notice.bad { color: var(--bad); }
.summary {
  margin: 16px 0 18px; padding: 14px 16px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 12px; font-size: 14px;
  display: flex; flex-wrap: wrap; gap: 8px 20px;
}
.summary span { color: var(--muted); }
.summary b { color: var(--text); font-weight: 600; }
.jobs { display: grid; gap: 12px; }
.job { padding: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.job-head { display: flex; align-items: flex-start; gap: 12px; }
.ordinal {
  flex: none; width: 30px; height: 30px; border-radius: 8px; background: var(--track);
  color: var(--muted); font-size: 12px; display: grid; place-items: center; font-variant-numeric: tabular-nums;
}
.job-title { flex: 1; min-width: 0; }
.spec { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
.track {
  position: relative; height: 8px; margin: 14px 0 8px; border-radius: 999px;
  background: var(--track); overflow: hidden;
}
.fill { height: 100%; width: 0; border-radius: inherit; background: var(--accent); transition: width .45s ease; }
.track.complete .fill { background: var(--good); }
.track.failed .fill { background: var(--bad); }
.track.indeterminate .fill {
  width: 34%;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--muted) 55%, transparent), transparent);
  animation: sweep 1.9s ease-in-out infinite;
}
@keyframes sweep { 0% { transform: translateX(-110%); } 100% { transform: translateX(300%); } }
@media (prefers-reduced-motion: reduce) {
  .fill { transition: none; }
  .track.indeterminate .fill { animation: none; width: 30%; opacity: .55; }
}
.job-meta { display: flex; flex-wrap: wrap; gap: 4px 18px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.job-meta .pct { color: var(--text); font-weight: 600; }
.error { margin: 10px 0 0; color: var(--bad); font-size: 12px; overflow-wrap: anywhere; }
.foot {
  margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--line);
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  color: var(--muted); font-size: 12px;
}
.refresh {
  font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px; padding: 6px 14px; cursor: pointer;
}
.refresh:hover { border-color: var(--muted); }
.refresh:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 480px) {
  body { padding: 20px 14px 36px; }
  .job { padding: 14px; }
}
`;
const SCRIPT = `
(function () {
  var params = new URLSearchParams(location.hash.replace(/^#/, ""));
  var token = params.get("t") || "";
  var notice = document.getElementById("notice");
  var summary = document.getElementById("summary");
  var jobsRoot = document.getElementById("jobs");
  var batchId = document.getElementById("batch-id");
  var batchStatus = document.getElementById("batch-status");
  var observed = document.getElementById("observed");
  var refreshButton = document.getElementById("refresh");
  var timer = null;
  var currentBatch = "";

  var STAGE_TEXT = {
    local_queue: "等待提交",
    submitting: "正在提交",
    accepted: "已受理",
    submission_unknown: "提交结果未知",
    generating: "生成中",
    download_pending: "等待下载",
    downloading: "下载中",
    ready: "已交付",
    download_failed: "下载失败",
    failed: "失败"
  };
  var QUALITY_TEXT = {
    pending: "尚未开始",
    unknown: "接口未提供进度",
    legacy_ambiguous: "尚无可靠进度",
    not_applicable: "未生成",
    complete: "已完成"
  };
  var STATUS_TEXT = {
    queued: "已排队",
    running: "进行中",
    done: "已完成",
    partial: "部分完成",
    failed: "失败",
    stopped: "已停止"
  };

  function pad(value) { return value < 10 ? "0" + value : String(value); }

  function elapsedText(iso) {
    var started = Date.parse(iso);
    if (!isFinite(started)) return "";
    var seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var rest = seconds % 60;
    if (hours > 0) return hours + " 小时 " + pad(minutes) + " 分";
    return pad(minutes) + ":" + pad(rest);
  }

  function agoText(iso) {
    var then = Date.parse(iso);
    if (!isFinite(then)) return "";
    var seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 10) return "刚刚";
    if (seconds < 60) return seconds + " 秒前";
    if (seconds < 3600) return Math.floor(seconds / 60) + " 分钟前";
    return Math.floor(seconds / 3600) + " 小时前";
  }

  function pillClass(stage) {
    if (stage === "ready") return "pill good";
    if (stage === "failed" || stage === "download_failed" || stage === "submission_unknown") return "pill bad";
    if (stage === "download_pending" || stage === "local_queue") return "pill warn";
    return "pill live";
  }

  function progressText(job) {
    if (job.progress === null) return QUALITY_TEXT[job.progress_quality] || "进度未知";
    if (job.progress_quality === "interface_100_pending") return job.progress + "% · 等待确认";
    if (job.stage === "download_failed") return job.progress + "%（生成完成）";
    return job.progress + "%";
  }

  function specText(job) {
    var parts = [];
    if (job.params) {
      if (job.params.duration) parts.push(job.params.duration + " 秒");
      if (job.params.resolution) parts.push(job.params.resolution);
      if (job.params.aspect_ratio) parts.push(job.params.aspect_ratio === "landscape" ? "横屏" : "竖屏");
    }
    return parts.join(" · ");
  }

  function renderJob(job) {
    var card = document.createElement("article");
    card.className = "job";

    var head = document.createElement("div");
    head.className = "job-head";

    var ordinal = document.createElement("span");
    ordinal.className = "ordinal";
    ordinal.textContent = pad(job.ordinal);
    head.appendChild(ordinal);

    var title = document.createElement("div");
    title.className = "job-title";
    var name = document.createElement("h2");
    name.textContent = job.display_name;
    title.appendChild(name);
    var spec = document.createElement("p");
    spec.className = "spec";
    spec.textContent = specText(job);
    title.appendChild(spec);
    head.appendChild(title);

    var stage = document.createElement("span");
    stage.className = pillClass(job.stage);
    stage.textContent = STAGE_TEXT[job.stage] || job.stage;
    head.appendChild(stage);
    card.appendChild(head);

    var track = document.createElement("div");
    track.className = "track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "第 " + job.ordinal + " 条生成进度");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    var fill = document.createElement("div");
    fill.className = "fill";
    track.appendChild(fill);

    if (job.progress === null) {
      track.classList.add("indeterminate");
      track.setAttribute("aria-valuetext", progressText(job));
    } else {
      if (job.progress_quality === "complete") track.classList.add("complete");
      if (job.stage === "failed") track.classList.add("failed");
      track.setAttribute("aria-valuenow", String(job.progress));
      fill.style.width = job.progress + "%";
    }
    card.appendChild(track);

    var meta = document.createElement("div");
    meta.className = "job-meta";
    var pct = document.createElement("span");
    pct.className = "pct";
    pct.textContent = progressText(job);
    meta.appendChild(pct);
    var elapsed = document.createElement("span");
    elapsed.textContent = job.stage === "local_queue" || job.stage === "submitting"
      ? "登记后 " + elapsedText(job.created_at)
      : "登记后已过 " + elapsedText(job.created_at);
    meta.appendChild(elapsed);
    var updated = document.createElement("span");
    updated.textContent = "记录更新于 " + agoText(job.record_updated_at);
    meta.appendChild(updated);
    card.appendChild(meta);

    if (job.safe_error) {
      var error = document.createElement("p");
      error.className = "error";
      error.textContent = job.safe_error;
      card.appendChild(error);
    }
    return card;
  }

  function renderSummary(snapshot) {
    var parts = [];
    function add(label, value) {
      if (!value) return;
      var item = document.createElement("span");
      var strong = document.createElement("b");
      strong.textContent = String(value);
      item.appendChild(strong);
      item.appendChild(document.createTextNode(" " + label));
      parts.push(item);
    }
    add("已交付", snapshot.counts.ready + " / " + snapshot.counts.total);
    add("生成中", snapshot.counts.generating);
    add("已受理", snapshot.counts.accepted);
    add("等待提交", snapshot.counts.waiting);
    add("生成后待下载", snapshot.counts.succeeded);
    add("失败", snapshot.counts.failed);
    add("待核对", snapshot.counts.unknown);
    if (!parts.length) {
      var empty = document.createElement("span");
      empty.textContent = "本批次没有任务记录。";
      parts.push(empty);
    }
    summary.replaceChildren.apply(summary, parts);
  }

  function batchStatusText(snapshot) {
    if (
      !snapshot.terminal &&
      snapshot.batch_status === "queued" &&
      snapshot.counts.waiting < snapshot.counts.total
    ) {
      return "进行中";
    }
    return STATUS_TEXT[snapshot.batch_status] || snapshot.batch_status;
  }

  function batchPillClass(snapshot) {
    if (snapshot.batch_status === "done") return "pill good";
    if (snapshot.batch_status === "failed") return "pill bad";
    if (snapshot.batch_status === "partial" || snapshot.batch_status === "stopped") return "pill warn";
    return "pill live";
  }

  function render(snapshot) {
    currentBatch = snapshot.batch_id;
    batchId.textContent = "批次 " + snapshot.batch_id;
    batchStatus.textContent = batchStatusText(snapshot);
    batchStatus.className = batchPillClass(snapshot);
    renderSummary(snapshot);
    jobsRoot.replaceChildren.apply(jobsRoot, snapshot.jobs.map(renderJob));
    observed.textContent = "快照 " + new Date(snapshot.observed_at).toLocaleTimeString() +
      (snapshot.terminal ? " · 批次已结束，自动刷新已停止" : " · 每 2 秒自动刷新");
    notice.textContent = snapshot.terminal ? "" : "百分比来自接口记录；排队与渲染无法单独区分。";
    notice.className = "notice";
  }

  function schedule(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(load, delay);
  }

  async function load() {
    if (!token) {
      notice.textContent = "缺少访问令牌。请通过插件重新打开进度页。";
      notice.className = "notice bad";
      return;
    }
    try {
      var response = await fetch("/api/state", {
        headers: { "X-Progress-Token": token },
        cache: "no-store"
      });
      if (response.status === 401 || response.status === 403) {
        notice.textContent = "访问令牌无效或已过期。请重新打开进度页。";
        notice.className = "notice bad";
        return;
      }
      if (!response.ok) throw new Error("HTTP " + response.status);
      var snapshot = await response.json();
      render(snapshot);
      if (snapshot.terminal) return;
      schedule(document.hidden ? 10000 : 2000);
    } catch (error) {
      notice.textContent = "监控连接断开，视频任务不一定停止。正在重试…";
      notice.className = "notice bad";
      observed.textContent = currentBatch ? "批次 " + currentBatch : "";
      schedule(5000);
    }
  }

  refreshButton.addEventListener("click", function () { load(); });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) load();
  });
  load();
})();
`;
export function renderProgressPage() {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>视频生成进度</title>
<style>${STYLE}</style>
</head>
<body>
<div class="page">
  <header class="head">
    <div>
      <h1>视频生成进度</h1>
      <p class="batch" id="batch-id">读取中…</p>
    </div>
    <span class="pill" id="batch-status">读取中</span>
  </header>
  <p class="notice" id="notice" role="status" aria-live="polite"></p>
  <section class="summary" id="summary" aria-label="批次汇总"></section>
  <main class="jobs" id="jobs"></main>
  <footer class="foot">
    <span id="observed"></span>
    <button type="button" class="refresh" id="refresh">刷新</button>
  </footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
