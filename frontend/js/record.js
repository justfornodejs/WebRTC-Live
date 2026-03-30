/**
 * WebRTC 录制流管理模块
 *
 * 功能描述：
 *   使用浏览器原生 MediaRecorder API 录制视频流，支持多种保存方式
 *
 * 核心功能：
 *   - 流录制：实时录制推流或拉流的视频画面
 *   - 状态管理：录制状态机（idle → recording → paused → completed）
 *   - 多格式支持：自动检测浏览器支持的录制格式（WebM/MP4）
 *   - 本地保存：支持生成下载链接，触发浏览器下载
 *   - 服务器上传：支持上传录制文件到后端存储
 *   - 进度回调：实时反馈录制时长和上传进度
 *
 * 技术实现：
 *   - MediaRecorder API：浏览器原生录制 API，无需插件
 *   - Blob 数据管理：分块收集录制数据，最终合并为 Blob 对象
 *   - XMLHttpRequest：用于文件上传时的进度监听
 *   - 时间限制：可配置最大录制时长（0 表示无限制）
 *
 * 支持的录制格式（优先顺序）：
 *   1. video/webm;codecs=vp9,opus（VP9 + Opus，最佳质量）
 *   2. video/webm;codecs=vp8,opus（VP8 + Opus，兼容性好）
 *   3. video/webm;codecs=vp9（仅 VP9 视频）
 *   4. video/webm;codecs=vp8（仅 VP8 视频）
 *   5. video/webm（WebM 默认格式）
 *   6. video/mp4（MP4 格式，部分浏览器支持）
 *
 * 使用示例：
 * ```javascript
 * const recorder = new StreamRecorder({
 *     mimeType: 'video/webm;codecs=vp9,opus',
 *     maxDuration: 3600,  // 最长 1 小时
 *     onStateChange: (state) => console.log('状态:', state),
 *     onProgress: (duration) => console.log('时长:', duration, '秒'),
 *     onError: (error) => console.error('错误:', error)
 * });
 *
 * // 开始录制
 * recorder.start(mediaStream);
 *
 * // 停止录制
 * recorder.stop();
 *
 * // 下载到本地
 * recorder.download('my-video');
 *
 * // 上传到服务器
 * recorder.uploadToServer({
 *     filename: 'session-record',
 *     onProgress: (percent) => console.log('上传:', percent + '%'),
 *     onSuccess: (resp) => console.log('上传成功:', resp),
 *     onError: (err) => console.error('上传失败:', err)
 * });
 * ```
 *
 * 浏览器兼容性：
 *   - Chrome 50+ ✅
 *   - Firefox 30+ ✅
 *   - Safari 14.1+ ✅（部分格式限制）
 *   - Edge (Chromium) ✅
 *
 * @author WebRTC-Live Project
 * @version 1.0.0
 * @last-modified 2026-03-30
 */

class StreamRecorder {
    constructor(options = {}) {
        // 配置选项
        this.options = {
            mimeType: 'video/webm;codecs=vp9,opus', // 首选格式
            timeSlice: 1000, // 录制数据块分割时间（毫秒）
            maxDuration: 3600, // 最大录制时长（秒），0 表示无限制
            onStateChange: options.onStateChange || (() => {}),
            onProgress: options.onProgress || (() => {}),
            onError: options.onError || (() => {}),
            ...options
        };

        // 状态
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.recordedBlob = null;
        this.recordingStartTime = 0;
        this.durationTimer = null;
        this.currentDuration = 0;
        this.state = 'idle'; // idle, recording, paused, completed

        // 检测支持的 MIME 类型
        this.mimeType = this.detectSupportedMimeType();
    }

    /**
     * 检测浏览器支持的录制格式
     */
    detectSupportedMimeType() {
        const preferredTypes = [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm',
            'video/mp4'
        ];

        for (const type of preferredTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
                console.log(`[Recorder] 支持的格式: ${type}`);
                return type;
            }
        }

        // 如果都不支持，让浏览器自动选择
        console.warn('[Recorder] 未找到支持的格式，使用默认格式');
        return '';
    }

    /**
     * 开始录制
     * @param {MediaStream} stream - 要录制的媒体流
     */
    start(stream) {
        if (this.state === 'recording') {
            console.warn('[Recorder] 已在录制中');
            return;
        }

        if (!stream) {
            this.options.onError(new Error('没有提供媒体流'));
            return;
        }

        try {
            // 清空之前的数据
            this.recordedChunks = [];
            this.recordedBlob = null;

            // 创建 MediaRecorder
            const options = this.mimeType ? { mimeType: this.mimeType } : {};
            this.mediaRecorder = new MediaRecorder(stream, options);

            // 监听数据可用事件
            this.mediaRecorder.addEventListener('dataavailable', (event) => {
                if (event.data && event.data.size > 0) {
                    this.recordedChunks.push(event.data);
                }
            });

            // 监听录制停止事件
            this.mediaRecorder.addEventListener('stop', () => {
                this.completeRecording();
            });

            // 监听错误事件
            this.mediaRecorder.addEventListener('error', (event) => {
                console.error('[Recorder] 录制错误:', event);
                this.options.onError(event.error);
            });

            // 开始录制
            this.mediaRecorder.start(this.options.timeSlice);
            this.recordingStartTime = Date.now();
            this.currentDuration = 0;
            this.state = 'recording';

            // 启动计时器
            this.startDurationTimer();

            this.options.onStateChange(this.state);
            console.log('[Recorder] 开始录制');
        } catch (error) {
            console.error('[Recorder] 启动录制失败:', error);
            this.options.onError(error);
        }
    }

    /**
     * 暂停录制
     */
    pause() {
        if (this.state !== 'recording') {
            return;
        }

        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            this.mediaRecorder.pause();
            this.state = 'paused';
            this.pauseDurationTimer();
            this.options.onStateChange(this.state);
            console.log('[Recorder] 录制已暂停');
        }
    }

    /**
     * 恢复录制
     */
    resume() {
        if (this.state !== 'paused') {
            return;
        }

        if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
            this.mediaRecorder.resume();
            this.state = 'recording';
            this.resumeDurationTimer();
            this.options.onStateChange(this.state);
            console.log('[Recorder] 录制已恢复');
        }
    }

    /**
     * 停止录制
     */
    stop() {
        if (this.state !== 'recording' && this.state !== 'paused') {
            return;
        }

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
            this.stopDurationTimer();
            this.state = 'completed';
            this.options.onStateChange(this.state);
            console.log('[Recorder] 录制已停止');
        }
    }

    /**
     * 完成录制处理
     */
    completeRecording() {
        // 合并所有数据块
        this.recordedBlob = new Blob(this.recordedChunks, {
            type: this.mimeType || 'video/webm'
        });

        console.log(`[Recorder] 录制完成，大小: ${this.formatFileSize(this.recordedBlob.size)}`);
    }

    /**
     * 下载录制的视频到本地
     * @param {string} filename - 下载文件名（不含扩展名）
     */
    download(filename = 'recording') {
        if (!this.recordedBlob) {
            console.warn('[Recorder] 没有可下载的录制数据');
            return false;
        }

        try {
            // 生成文件名（添加时间戳）
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
            const extension = this.getExtension();
            const fullFilename = `${filename}_${timestamp}${extension}`;

            // 创建下载链接
            const url = URL.createObjectURL(this.recordedBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fullFilename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // 释放 URL 对象
            setTimeout(() => URL.revokeObjectURL(url), 100);

            console.log(`[Recorder] 已下载: ${fullFilename}`);
            return true;
        } catch (error) {
            console.error('[Recorder] 下载失败:', error);
            this.options.onError(error);
            return false;
        }
    }

    /**
     * 上传录制的视频到服务器
     * @param {Object} options - 上传选项
     * @param {string} options.filename - 文件名
     * @param {Function} options.onProgress - 上传进度回调
     * @param {Function} options.onSuccess - 上传成功回调
     * @param {Function} options.onError - 上传失败回调
     */
    async uploadToServer(options = {}) {
        if (!this.recordedBlob) {
            console.warn('[Recorder] 没有可上传的录制数据');
            if (!options.onError) {
                options.onError(new Error('没有可上传的录制数据'));
            }
            return false;
        }

        const {
            filename = 'recording',
            onProgress = () => {},
            onSuccess = () => {},
            onError = (error) => console.error('[Recorder] 上传失败:', error)
        } = options;

        try {
            // 生成文件名
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
            const extension = this.getExtension();
            const fullFilename = `${filename}_${timestamp}${extension}`;

            // 创建 FormData
            const formData = new FormData();
            formData.append('video', this.recordedBlob, fullFilename);

            console.log(`[Recorder] 开始上传: ${fullFilename} (${this.formatFileSize(this.recordedBlob.size)})`);

            // 发送上传请求
            const xhr = new XMLHttpRequest();

            // 监听上传进度
            xhr.upload.addEventListener('progress', (event) => {
                if (event.lengthComputable) {
                    const percent = Math.round((event.loaded / event.total) * 100);
                    onProgress(percent, event.loaded, event.total);
                }
            });

            // 监听上传完成
            xhr.addEventListener('load', () => {
                if (xhr.status === 200) {
                    const response = JSON.parse(xhr.responseText);
                    console.log('[Recorder] 上传成功:', response);
                    onSuccess(response);
                } else {
                    const error = new Error(`上传失败 (${xhr.status}): ${xhr.responseText}`);
                    console.error('[Recorder] 上传失败:', error);
                    onError(error);
                }
                xhr.upload.removeEventListener('progress');
                xhr.removeEventListener('load');
                xhr.removeEventListener('error');
            });

            // 监听上传错误
            xhr.addEventListener('error', () => {
                const error = new Error('网络错误，上传失败');
                console.error('[Recorder] 上传错误:', error);
                onError(error);
            });

            // 发送请求
            xhr.open('POST', '/api/recordings/upload');
            xhr.send(formData);

            return true;
        } catch (error) {
            console.error('[Recorder] 上传异常:', error);
            onError(error);
            return false;
        }
    }

    /**
     * 获取文件扩展名
     */
    getExtension() {
        if (this.mimeType.includes('mp4')) {
            return '.mp4';
        }
        return '.webm';
    }

    /**
     * 格式化文件大小
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * 启动时长计时器
     */
    startDurationTimer() {
        this.stopDurationTimer();
        this.durationTimer = setInterval(() => {
            this.currentDuration++;
            this.options.onProgress(this.currentDuration);

            // 检查是否达到最大时长
            if (this.options.maxDuration > 0 && this.currentDuration >= this.options.maxDuration) {
                console.log('[Recorder] 达到最大录制时长，自动停止');
                this.stop();
            }
        }, 1000);
    }

    /**
     * 暂停时长计时器
     */
    pauseDurationTimer() {
        if (this.durationTimer) {
            clearInterval(this.durationTimer);
            this.durationTimer = null;
        }
    }

    /**
     * 恢复时长计时器
     */
    resumeDurationTimer() {
        this.startDurationTimer();
    }

    /**
     * 停止时长计时器
     */
    stopDurationTimer() {
        this.pauseDurationTimer();
    }

    /**
     * 获取当前录制时长（秒）
     */
    getDuration() {
        return this.currentDuration;
    }

    /**
     * 获取当前状态
     */
    getState() {
        return this.state;
    }

    /**
     * 获取录制数据大小
     */
    getBlobSize() {
        return this.recordedBlob ? this.recordedBlob.size : 0;
    }

    /**
     * 清理资源
     */
    destroy() {
        this.stop();
        this.recordedChunks = [];
        this.recordedBlob = null;
        this.mediaRecorder = null;
        this.state = 'idle';
    }
}

/**
 * 格式化时间为 HH:MM:SS
 * @param {number} seconds - 秒数
 * @returns {string} 格式化时间字符串
 */
function formatRecordTime(seconds) {
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
}
