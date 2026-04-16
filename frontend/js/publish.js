/**
 * WebRTC 推流控制模块
 *
 * 功能描述：
 *   实现浏览器端 WebRTC 推流功能，支持多种媒体源和实时状态监控
 *
 * 核心功能：
 *   - 多媒体源推流：屏幕共享、摄像头捕获、本地视频文件
 *   - WebRTC 连接管理：建立连接、状态监控、异常处理
 *   - 实时统计：分辨率、帧率、码率等信息采集
 *   - 本地录制：支持推流画面的录制与上传
 *
 * 技术架构：
 *   1. 媒体流采集：通过 getUserMedia / getDisplayMedia API
 *   2. WebRTC 连接：创建 RTCPeerConnection、SDP 交换、ICE 候选收集
 *   3. 信令协商：通过 Flask 后端代理与 SRS 服务器交换 SDP
 *   4. 媒体传输：通过 WebRTC UDP 协议传输到 SRS 服务器
 *
 * 状态管理：
 *   - isPublishing: 推流状态标志
 *   - publishPC: RTCPeerConnection 实例
 *   - publishStream: 媒体流对象（MediaStream）
 *   - publishDuration: 推流时长（秒）
 *
 * 依赖模块：
 *   - utils.js: 公共工具函数（SDP 处理、信令请求等）
 *   - record.js: 录制功能模块（StreamRecorder 类）
 *
 * @author WebRTC-Live Project
 * @version 1.0.0
 * @last-modified 2026-03-30
 */

let publishPC = null;
let publishStream = null;
let isPublishing = false;
let publishTimer = null;
let publishDuration = 0;
let statsTimer = null;
let lastBytesSent = 0;

// 录制相关变量
let streamRecorder = null;
let isRecording = false;

document.addEventListener("DOMContentLoaded", () => {
    const previewVideo = document.getElementById("previewVideo");
    const placeholder = document.getElementById("videoPlaceholder");
    const overlay = document.getElementById("videoOverlay");
    const sourceSelect = document.getElementById("sourceSelect");
    const startBtn = document.getElementById("startPublishBtn");
    const stopBtn = document.getElementById("stopPublishBtn");
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    const durationText = document.getElementById("durationText");
    const logPanel = document.getElementById("logPanel");
    const bitrateEl = document.getElementById("statBitrate");
    const snapshotBtn = document.getElementById("snapshotBtn");
    const cameraDeviceGroup = document.getElementById("cameraDeviceGroup");
    const videoSource = document.getElementById("videoSource");
    const enableAudio = document.getElementById("enableAudio");
    const enableSystemAudio = document.getElementById("enableSystemAudio");
    const systemAudioGroup = document.getElementById("systemAudioGroup");

    // 初始化设备列表
    async function initDevices() {
        try {
            // 先请求一次权限以获得真实的设备标签
            await navigator.mediaDevices.getUserMedia({ video: true });
            const devices = await navigator.mediaDevices.enumerateDevices();
            videoSource.innerHTML = "";
            devices.forEach(device => {
                if (device.kind === "videoinput") {
                    const option = document.createElement("option");
                    option.value = device.deviceId;
                    option.text = device.label || `Camera ${videoSource.length + 1}`;
                    videoSource.appendChild(option);
                }
            });
        } catch (e) {
            addLog("获取设备列表失败：" + e.message, "warn");
        }
    }

    sourceSelect.addEventListener("change", () => {
        const val = sourceSelect.value;
        if (val === "camera") {
            cameraDeviceGroup.classList.remove("hidden");
            systemAudioGroup.classList.add("hidden");
            initDevices();
        } else {
            cameraDeviceGroup.classList.add("hidden");
            // 只有屏幕共享和视频文件支持捕获系统声音
            systemAudioGroup.classList.remove("hidden");
        }
    });

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

    /**
     * 核心混音函数：将麦克风音轨和系统音轨混合
     */
    async function mixAudio(videoStream, micStream) {
        // 如果没有音频轨道，直接返回原流
        const hasMic = micStream && micStream.getAudioTracks().length > 0;
        const hasSys = videoStream && videoStream.getAudioTracks().length > 0;

        if (!hasMic && !hasSys) return videoStream;
        if (hasMic && !hasSys) {
            // 只有麦克风，将麦克风音轨添加到视频流
            videoStream.addTrack(micStream.getAudioTracks()[0]);
            return videoStream;
        }
        if (!hasMic && hasSys) return videoStream; // 只有系统音

        // 两者都有，执行 Web Audio 混音
        addLog("正在启动硬件混音引擎...", "info");
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const destination = audioCtx.createMediaStreamDestination();

        const micSource = audioCtx.createMediaStreamSource(micStream);
        const sysSource = audioCtx.createMediaStreamSource(videoStream);

        micSource.connect(destination);
        sysSource.connect(destination);

        // 移除原有的系统音轨（如果有），替换为压缩后的混合音轨
        const mixedAudioTrack = destination.stream.getAudioTracks()[0];
        videoStream.getAudioTracks().forEach(t => videoStream.removeTrack(t));
        videoStream.addTrack(mixedAudioTrack);

        return videoStream;
    }

    async function getMediaStream() {
        const source = sourceSelect.value;
        const micEnabled = enableAudio.checked;
        const sysAudioEnabled = enableSystemAudio.checked;
        
        let vStream = null;
        let mStream = null;

        try {
            // 1. 获取视频源（可能带系统音频）
            if (source === "screen") {
                addLog(`正在请求屏幕共享 (系统音频: ${sysAudioEnabled})...`);
                vStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { cursor: "always", width: { ideal: 1920 }, height: { ideal: 1080 } },
                    audio: sysAudioEnabled
                });
            } else if (source === "camera") {
                const deviceId = videoSource.value;
                addLog(`正在请求摄像头权限 (Device: ${deviceId})...`);
                vStream = await navigator.mediaDevices.getUserMedia({
                    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
                    audio: false // 摄像头模式下，人声独立通过 micStream 处理
                });
            } else if (source === "video-file") {
                vStream = await new Promise((resolve, reject) => {
                    const fi = document.createElement("input");
                    fi.type = "file"; fi.accept = "video/*";
                    fi.onchange = async (e) => {
                        const file = e.target.files[0];
                        if (!file) return reject(new Error("未选择文件"));
                        addLog(`加载视频文件: ${file.name}`);
                        const tv = document.createElement("video");
                        tv.src = URL.createObjectURL(file); tv.muted = true; tv.loop = true;
                        await tv.play();
                        resolve(tv.captureStream());
                    };
                    fi.click();
                });
            }

            // 2. 获取人声麦克风（如果启用）
            if (micEnabled) {
                try {
                    addLog("正在启动麦克风捕获...");
                    mStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                } catch (ae) {
                    addLog("麦克风启动失败: " + ae.message, "warn");
                }
            }

            // 3. 混音处理
            return await mixAudio(vStream, mStream);

        } catch (err) {
            if (err.name === 'NotReadableError') {
                throw new Error("硬件设备被占用。请关闭占用摄像头/麦克风的其他软件。");
            }
            throw err;
        }
    }

    async function startPublish() {
        if (isPublishing) { addLog("推流已在进行中", "warn"); return; }
        try {
            updateStatus("connecting", "正在连接...");
            startBtn.disabled = true;
            addLog("===== 开始推流 =====");

            publishStream = await getMediaStream();
            addLog(`获取媒体流成功，轨道数: ${publishStream.getTracks().length}`, "success");

            previewVideo.srcObject = publishStream;
            previewVideo.muted = true;
            await previewVideo.play();
            placeholder.classList.add("hidden");
            overlay.classList.remove("hidden");

            publishStream.getTracks().forEach(t => t.addEventListener("ended", () => { addLog(`轨道 [${t.kind}] 已结束`, "warn"); stopPublish(); }));

            publishPC = createPeerConnection();
            publishPC.addEventListener("connectionstatechange", () => {
                const s = publishPC.connectionState;
                if (s === "connected") { updateStatus("connected", "推流中"); addLog("✅ 推流连接已建立！", "success"); showToast("推流成功", "success"); }
                else if (s === "failed") { updateStatus("error", "连接失败"); addLog("❌ 连接失败", "error"); showToast("推流连接失败", "error"); }
            });

            publishStream.getTracks().forEach(t => { publishPC.addTrack(t, publishStream); addLog(`添加轨道: ${t.kind}`); });

            const offer = await publishPC.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
            offer.sdp = preferH264(offer.sdp);
            await publishPC.setLocalDescription(offer);
            addLog("等待 ICE 候选收集...");
            const completeSdp = await waitForIceGathering(publishPC);
            addLog("ICE 收集完成", "success");

            addLog("发送信令到 SRS...");
            const result = await sendSignaling("/api/publish", completeSdp);
            await publishPC.setRemoteDescription({ type: "answer", sdp: result.sdp });
            addLog("信令协商完成", "success");

            isPublishing = true;
            publishDuration = 0;
            startBtn.classList.add("hidden");
            stopBtn.classList.remove("hidden");
            publishTimer = setInterval(() => { publishDuration++; durationText.textContent = formatTime(publishDuration); }, 1000);
            startStatsMonitor();

            // 启用录制和拍照按钮
            const recordBtn = document.getElementById("startRecordBtn");
            if (recordBtn) recordBtn.disabled = false;
            snapshotBtn.disabled = false;
        } catch (err) {
            addLog(`❌ 推流失败: ${err.message}`, "error");
            updateStatus("error", "推流失败");
            showToast(`推流失败: ${err.message}`, "error");
            startBtn.disabled = false;
            cleanup();
        }
    }

    function stopPublish() {
        addLog("===== 停止推流 =====", "warn");
        cleanup();
        updateStatus("idle", "未推流");
        startBtn.classList.remove("hidden"); startBtn.disabled = false;
        stopBtn.classList.add("hidden");
        placeholder.classList.remove("hidden"); overlay.classList.add("hidden");
        durationText.textContent = "00:00:00";
        if (resolutionEl) resolutionEl.textContent = "-";
        if (framerateEl) framerateEl.textContent = "-";
        if (bitrateEl) bitrateEl.textContent = "-";
        showToast("推流已停止", "info");
    }

    function cleanup() {
        if (publishTimer) { clearInterval(publishTimer); publishTimer = null; }
        if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
        if (publishPC) { publishPC.close(); publishPC = null; }
        if (publishStream) { publishStream.getTracks().forEach(t => t.stop()); publishStream = null; }
        previewVideo.srcObject = null;
        isPublishing = false;
        snapshotBtn.disabled = true;
    }

    function startStatsMonitor() {
        lastBytesSent = 0;
        statsTimer = setInterval(async () => {
            if (!publishPC) return;
            try {
                const stats = await publishPC.getStats();
                stats.forEach(r => {
                    if (r.type === "outbound-rtp" && r.kind === "video") {
                        if (r.frameWidth && r.frameHeight) resolutionEl.textContent = `${r.frameWidth}×${r.frameHeight}`;
                        if (r.framesPerSecond !== undefined) framerateEl.textContent = `${r.framesPerSecond} fps`;
                        if (r.bytesSent !== undefined) {
                            if (lastBytesSent > 0) bitrateEl.textContent = `${(((r.bytesSent - lastBytesSent) * 8 / 2) / 1000).toFixed(0)} kbps`;
                            lastBytesSent = r.bytesSent;
                        }
                    }
                });
            } catch (e) { /* ignore */ }
        }, 2000);
    }

    startBtn.addEventListener("click", startPublish);
    stopBtn.addEventListener("click", stopPublish);

    // 拍照功能实现
    snapshotBtn.addEventListener("click", () => {
        if (!previewVideo || !isPublishing) return;
        
        try {
            const canvas = document.createElement("canvas");
            canvas.width = previewVideo.videoWidth;
            canvas.height = previewVideo.videoHeight;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(previewVideo, 0, 0, canvas.width, canvas.height);
            
            const dataURL = canvas.toDataURL("image/png");
            const link = document.createElement("a");
            const time = new Date().toISOString().replace(/[:.]/g, "-");
            link.download = `snapshot-${time}.png`;
            link.href = dataURL;
            link.click();
            
            addLog("📸 拍照成功，正在保存...", "success");
            showToast("截图已保存", "success");
        } catch (e) {
            addLog("❌ 拍照失败: " + e.message, "error");
        }
    });

    addLog("推流模块已加载，等待操作...");
    if (!checkWebRTCSupport()) { addLog("⚠️ 浏览器不支持 WebRTC", "error"); startBtn.disabled = true; }
    if (!checkScreenCaptureSupport()) { addLog("⚠️ 浏览器不支持屏幕捕获", "warn"); }

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
        if (!publishStream) {
            addLog("⚠️ 请先开始推流", "warn");
            showToast("请先开始推流", "info");
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

            streamRecorder.start(publishStream);
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
            const success = streamRecorder.download('publish-recording');
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
            filename: 'publish-recording',
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

    // 监听推流停止时清理录制
    const originalStopPublish = stopPublish;
    stopPublish = function() {
        if (isRecording) {
            stopRecord();
        }
        originalStopPublish();
    };
});
