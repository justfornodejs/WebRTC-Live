/**
 * WebRTC 拉流播放模块
 * 功能：从 SRS 拉取 WebRTC 流并播放，状态管理，实时统计
 * 依赖：utils.js
 */

let playPC = null;
let isPlaying = false;
let playTimer = null;
let playDuration = 0;
let playStatsTimer = null;
let lastBytesReceived = 0;

// 录制相关变量
let streamRecorder = null;
let isRecording = false;

document.addEventListener("DOMContentLoaded", () => {
    const remoteVideo = document.getElementById("remoteVideo");
    const placeholder = document.getElementById("videoPlaceholder");
    const overlay = document.getElementById("videoOverlay");
    const startBtn = document.getElementById("startPlayBtn");
    const stopBtn = document.getElementById("stopPlayBtn");
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    const durationText = document.getElementById("durationText");
    const logPanel = document.getElementById("logPanel");
    const resolutionEl = document.getElementById("statResolution");
    const framerateEl = document.getElementById("statFramerate");
    const bitrateEl = document.getElementById("statBitrate");

    function addLog(msg, level = "info") {
        const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        const entry = document.createElement("div");
        entry.className = `log-entry ${level}`;
        entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${msg}</span>`;
        logPanel.appendChild(entry);
        logPanel.scrollTop = logPanel.scrollHeight;
    }

    function updateStatus(state, text) {
        statusDot.className = `status-dot ${state}`;
        statusText.textContent = text;
    }

    function showToast(message, type = "info") {
        let container = document.querySelector(".toast-container");
        if (!container) {
            container = document.createElement("div");
            container.className = "toast-container";
            document.body.appendChild(container);
        }
        const icons = { success: "✅", error: "❌", info: "ℹ️" };
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span>${icons[type] || ""}</span><span>${message}</span>`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = "toast-out 0.3s ease-in forwards";
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    async function startPlay() {
        if (isPlaying) { addLog("已在播放中", "warn"); return; }
        try {
            updateStatus("connecting", "正在连接...");
            startBtn.disabled = true;
            addLog("===== 开始拉流 =====");

            // 创建 PeerConnection
            playPC = createPeerConnection();

            // 监听远端轨道
            playPC.addEventListener("track", (event) => {
                addLog(`收到远端轨道: ${event.track.kind}`, "success");
                if (event.streams && event.streams[0]) {
                    remoteVideo.srcObject = event.streams[0];
                    remoteVideo.play().catch(e => addLog(`自动播放失败: ${e.message}`, "warn"));
                    placeholder.classList.add("hidden");
                    overlay.classList.remove("hidden");
                }
            });

            // 监听连接状态
            playPC.addEventListener("connectionstatechange", () => {
                const s = playPC.connectionState;
                if (s === "connected") {
                    updateStatus("connected", "播放中");
                    addLog("✅ 拉流连接已建立！", "success");
                    showToast("播放连接已建立", "success");
                } else if (s === "failed") {
                    updateStatus("error", "连接失败");
                    addLog("❌ 拉流连接失败", "error");
                    showToast("播放连接失败", "error");
                }
            });

            // 添加接收轨道（recvonly）
            playPC.addTransceiver("video", { direction: "recvonly" });
            playPC.addTransceiver("audio", { direction: "recvonly" });
            addLog("已创建 recvonly 收发器");

            // 创建 Offer
            const offer = await playPC.createOffer();
            await playPC.setLocalDescription(offer);
            addLog("Offer 已创建");

            // 等待 ICE 收集
            addLog("等待 ICE 候选收集...");
            const completeSdp = await waitForIceGathering(playPC);
            addLog("ICE 收集完成", "success");

            // 发送拉流信令
            addLog("发送拉流信令到 SRS...");
            const result = await sendSignaling("/api/play", completeSdp);
            addLog("收到 SRS Answer", "success");

            // 设置远端描述
            await playPC.setRemoteDescription({ type: "answer", sdp: result.sdp });
            addLog("信令协商完成", "success");

            isPlaying = true;
            playDuration = 0;
            startBtn.classList.add("hidden");
            stopBtn.classList.remove("hidden");

            playTimer = setInterval(() => {
                playDuration++;
                durationText.textContent = formatTime(playDuration);
            }, 1000);

            startPlayStatsMonitor();

            // 启用录制按钮
            const recordBtn = document.getElementById("startRecordBtn");
            if (recordBtn) recordBtn.disabled = false;
        } catch (err) {
            addLog(`❌ 拉流失败: ${err.message}`, "error");
            updateStatus("error", "拉流失败");
            showToast(`拉流失败: ${err.message}`, "error");
            startBtn.disabled = false;
            cleanupPlay();
        }
    }

    function stopPlay() {
        addLog("===== 停止拉流 =====", "warn");
        cleanupPlay();
        updateStatus("idle", "未播放");
        startBtn.classList.remove("hidden"); startBtn.disabled = false;
        stopBtn.classList.add("hidden");
        placeholder.classList.remove("hidden"); overlay.classList.add("hidden");
        durationText.textContent = "00:00:00";
        if (resolutionEl) resolutionEl.textContent = "-";
        if (framerateEl) framerateEl.textContent = "-";
        if (bitrateEl) bitrateEl.textContent = "-";
        showToast("播放已停止", "info");
    }

    function cleanupPlay() {
        if (playTimer) { clearInterval(playTimer); playTimer = null; }
        if (playStatsTimer) { clearInterval(playStatsTimer); playStatsTimer = null; }
        if (playPC) { playPC.close(); playPC = null; }
        remoteVideo.srcObject = null;
        remoteVideo.pause();
        isPlaying = false;
    }

    function startPlayStatsMonitor() {
        lastBytesReceived = 0;
        playStatsTimer = setInterval(async () => {
            if (!playPC) return;
            try {
                const stats = await playPC.getStats();
                stats.forEach(r => {
                    if (r.type === "inbound-rtp" && r.kind === "video") {
                        if (r.frameWidth && r.frameHeight) resolutionEl.textContent = `${r.frameWidth}×${r.frameHeight}`;
                        if (r.framesPerSecond !== undefined) framerateEl.textContent = `${r.framesPerSecond} fps`;
                        if (r.bytesReceived !== undefined) {
                            if (lastBytesReceived > 0) bitrateEl.textContent = `${(((r.bytesReceived - lastBytesReceived) * 8 / 2) / 1000).toFixed(0)} kbps`;
                            lastBytesReceived = r.bytesReceived;
                        }
                    }
                });
            } catch (e) { /* ignore */ }
        }, 2000);
    }

    startBtn.addEventListener("click", startPlay);
    stopBtn.addEventListener("click", stopPlay);

    addLog("拉流模块已加载，等待操作...");
    if (!checkWebRTCSupport()) { addLog("⚠️ 浏览器不支持 WebRTC", "error"); startBtn.disabled = true; }

    // ============================================================
    // 录制控制逻辑
    // ============================================================

    const startRecordBtn = document.getElementById("startRecordBtn");
    const stopRecordBtn = document.getElementById("stopRecordBtn");
    const downloadRecordBtn = document.getElementById("downloadRecordBtn");
    const recordSaveMode = document.getElementById("recordSaveMode");
    const recordingInfo = document.getElementById("recordingInfo");
    const recordDuration = document.getElementById("recordDuration");
    const recordProgress = document.getElementById("recordProgress");

    function startRecord() {
        if (!remoteVideo.srcObject) {
            addLog("⚠️ 请先开始拉流", "warn");
            showToast("请先开始拉流", "info");
            return;
        }

        if (isRecording) {
            addLog("录制已在进行中", "warn");
            return;
        }

        try {
            streamRecorder = new StreamRecorder({
                onStateChange: (state) => {
                    isRecording = (state === 'recording');

                    if (state === 'recording') {
                        startRecordBtn.classList.add("hidden");
                        stopRecordBtn.classList.remove("hidden");
                        downloadRecordBtn.classList.add("hidden");
                        recordingInfo.style.display = "block";
                        recordProgress.classList.add("hidden");
                        addLog("🔴 开始录制", "info");
                    } else if (state === 'completed') {
                        addLog("⏹️ 录制完成", "success");
                        if (recordSaveMode.value === 'local') {
                            downloadRecordBtn.classList.remove("hidden");
                        }
                    }
                },
                onProgress: (duration) => {
                    recordDuration.textContent = formatRecordTime(duration);
                },
                onError: (error) => {
                    addLog(`❌ 录制错误: ${error.message}`, "error");
                    showToast(`录制错误: ${error.message}`, "error");
                    cleanupRecord();
                }
            });

            streamRecorder.start(remoteVideo.srcObject);
            showToast("开始录制", "success");
        } catch (error) {
            addLog(`❌ 启动录制失败: ${error.message}`, "error");
            showToast(`启动录制失败: ${error.message}`, "error");
        }
    }

    function stopRecord() {
        if (streamRecorder) {
            streamRecorder.stop();
            startRecordBtn.classList.remove("hidden");
            stopRecordBtn.classList.add("hidden");

            // 检查保存方式
            const saveMode = recordSaveMode.value;
            if (saveMode === 'server') {
                uploadToServer();
            }
        }
    }

    function downloadRecord() {
        if (streamRecorder && streamRecorder.getState() === 'completed') {
            const success = streamRecorder.download('play-recording');
            if (success) {
                showToast("视频已下载", "success");
                cleanupRecord();
            } else {
                showToast("下载失败", "error");
            }
        }
    }

    function uploadToServer() {
        if (!streamRecorder || streamRecorder.getState() !== 'completed') {
            return;
        }

        recordProgress.classList.remove("hidden");
        recordProgress.textContent = "上传中... 0%";

        streamRecorder.uploadToServer({
            filename: 'play-recording',
            onProgress: (percent) => {
                recordProgress.textContent = `上传中... ${percent}%`;
            },
            onSuccess: (response) => {
                addLog("✅ 视频已上传到服务器", "success");
                showToast("视频已上传到服务器", "success");
                cleanupRecord();
            },
            onError: (error) => {
                addLog(`❌ 上传失败: ${error.message}`, "error");
                showToast(`上传失败: ${error.message}`, "error");
                cleanupRecord();
            }
        });
    }

    function cleanupRecord() {
        if (streamRecorder) {
            streamRecorder.destroy();
            streamRecorder = null;
        }
        isRecording = false;
        recordingInfo.style.display = "none";
        recordDuration.textContent = "00:00:00";
        startRecordBtn.classList.remove("hidden");
        stopRecordBtn.classList.add("hidden");
        downloadRecordBtn.classList.add("hidden");
        recordProgress.classList.add("hidden");
    }

    // 绑定录制按钮事件
    if (startRecordBtn) startRecordBtn.addEventListener("click", startRecord);
    if (stopRecordBtn) stopRecordBtn.addEventListener("click", stopRecord);
    if (downloadRecordBtn) downloadRecordBtn.addEventListener("click", downloadRecord);

    // 监听拉流停止时清理录制
    const originalStopPlay = stopPlay;
    stopPlay = function() {
        if (isRecording) {
            stopRecord();
        }
        originalStopPlay();
    };
});
