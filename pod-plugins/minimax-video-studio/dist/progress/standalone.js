import { UserError } from "../core/errors.js";
import { startProgressServer } from "./server.js";
import { readProgressSnapshot } from "./snapshot.js";
function parseFlags(argv) {
    const flags = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg.startsWith("--"))
            continue;
        const body = arg.slice(2);
        const equals = body.indexOf("=");
        if (equals >= 0) {
            flags[body.slice(0, equals)] = body.slice(equals + 1);
            continue;
        }
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
            flags[body] = next;
            index += 1;
        }
        else {
            flags[body] = true;
        }
    }
    return flags;
}
function stringFlag(flags, name) {
    const value = flags[name];
    return typeof value === "string" ? value : undefined;
}
function numberFlag(flags, name, fallback) {
    const raw = stringFlag(flags, name);
    if (raw === undefined)
        return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed))
        throw new UserError(`--${name} 必须是数字。`, "invalid_flag");
    return parsed;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
async function main() {
    const flags = parseFlags(process.argv.slice(2));
    if (flags.help || flags.h) {
        process.stdout.write(`minimax-video-studio 进度页

用法：
  node dist/progress/standalone.js --batch-id ID [--idle-min 10]

说明：
  只监听 127.0.0.1，只读任务记录，不提交、不取消、不恢复、不下载。
  关闭本进程或页面不会影响后台生成任务。
`);
        return 0;
    }
    const batchId = stringFlag(flags, "batch-id");
    if (!batchId)
        throw new UserError("缺少 --batch-id。", "missing_batch_id");
    const idleMinutes = Math.max(1, numberFlag(flags, "idle-min", 10));
    // 启动前只读校验批次，避免给出一个打开后才报错的链接。
    readProgressSnapshot(batchId);
    const handle = await startProgressServer({ batchId, idleMs: idleMinutes * 60_000 });
    process.stdout.write(`${JSON.stringify({
        url: handle.url,
        batch_id: handle.batchId,
        idle_minutes: idleMinutes,
        note: "页面只读；关闭此进程不会影响生成任务。",
    })}\n`);
    process.stderr.write(`进度页已启动（仅本机）：${handle.url}\n`);
    await new Promise((resolve) => {
        let stopping = false;
        const stop = () => {
            if (stopping)
                return;
            stopping = true;
            void handle.close().then(resolve);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        const check = setInterval(() => {
            if (handle.closed && !stopping) {
                stopping = true;
                clearInterval(check);
                resolve();
            }
        }, 500);
        check.unref();
    });
    process.stderr.write("进度页已关闭；生成任务不受影响。\n");
    return 0;
}
main()
    .then((code) => {
    process.exitCode = code;
})
    .catch((error) => {
    process.stderr.write(`错误：${errorMessage(error)}\n`);
    process.exitCode = 1;
});
